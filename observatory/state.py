"""Runtime state: folds the event stream into Runs -> Agents / Tasks / counters.

The backend is the single reducer; the frontend receives snapshots plus raw events and only derives
presentation lists (tool calls, messages, errors) from the events it already holds.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .adapters import DISPLAY_NAMES
from .schema import MAIN, USER, Event

ACTIVE = {"planning", "running", "waiting"}
SPAWN_TOOLS = {"Task", "Agent"}


@dataclass
class Agent:
    id: str
    name: str
    kind: str = "agent"  # main | subagent | agent
    parent: str | None = None
    status: str = "idle"
    model: str | None = None
    task_id: str | None = None
    current_task: str | None = None
    current_action: str | None = None
    started_at: float | None = None
    ended_at: float | None = None
    last_active: float = 0.0
    llm_calls: int = 0
    tool_calls: int = 0
    messages: int = 0
    errors: int = 0
    tokens: int | None = None
    input: str | None = None
    output: str | None = None


@dataclass
class Task:
    id: str
    agent: str
    description: str = ""
    status: str = "created"
    created_at: float = 0.0
    started_at: float | None = None
    ended_at: float | None = None
    duration_ms: float | None = None
    error: str | None = None


@dataclass
class Run:
    run_id: str
    platform: str
    started_at: float
    updated_at: float
    title: str | None = None
    cwd: str | None = None
    model: str | None = None
    ended_at: float | None = None
    end_status: str | None = None
    agents: dict[str, Agent] = field(default_factory=dict)
    tasks: dict[str, Task] = field(default_factory=dict)
    event_count: int = 0
    llm_calls: int = 0
    tool_calls: int = 0
    messages: int = 0
    errors: int = 0
    tokens: int | None = None
    latency_total: float = 0.0
    latency_count: int = 0
    open_calls: dict[str, dict[str, Any]] = field(default_factory=dict)

    @property
    def status(self) -> str:
        if self.ended_at is not None:
            return self.end_status or "completed"
        if any(a.status in ACTIVE for a in self.agents.values()):
            return "running"
        root = self.agents.get(MAIN)
        if root and root.status == "failed":
            return "failed"
        return "idle"

    def metrics(self) -> dict[str, Any]:
        tasks = self.tasks.values()
        return {
            "active_agents": sum(a.status in ACTIVE for a in self.agents.values()),
            "total_agents": len(self.agents),
            "total_tasks": len(self.tasks),
            "completed_tasks": sum(t.status == "completed" for t in tasks),
            "failed_tasks": sum(t.status == "failed" for t in tasks),
            "llm_calls": self.llm_calls,
            "tool_calls": self.tool_calls,
            "messages": self.messages,
            "errors": self.errors,
            "total_tokens": self.tokens,
            "avg_latency_ms": round(self.latency_total / self.latency_count, 1) if self.latency_count else None,
            "events": self.event_count,
        }

    def summary(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id, "platform": self.platform, "title": self.title, "cwd": self.cwd,
            "model": self.model, "status": self.status, "started_at": self.started_at,
            "updated_at": self.updated_at, "ended_at": self.ended_at, "metrics": self.metrics(),
        }

    def snapshot(self) -> dict[str, Any]:
        return {
            **self.summary(),
            "agents": [vars(a) for a in self.agents.values()],
            "tasks": [vars(t) for t in self.tasks.values()],
        }


def _text(value: Any) -> str | None:
    if value is None:
        return None
    return value if isinstance(value, str) else str(value)


def _describe_call(data: dict[str, Any]) -> str:
    tool = data.get("tool_name") or "tool"
    if data.get("intent"):
        return f"{tool}: {data['intent']}"
    inp = data.get("input")
    if isinstance(inp, dict):
        for key in ("command", "file_path", "path", "pattern", "query", "url", "description", "prompt"):
            if inp.get(key):
                return f"{tool}: {str(inp[key])[:120]}"
    return tool


class RuntimeState:
    def __init__(self) -> None:
        self.runs: dict[str, Run] = {}
        self.aliases: dict[str, tuple[str, str]] = {}  # child run id -> (parent run id, agent id)
        self.subagent_runs: dict[str, str] = {}  # subagent id -> run id that spawned it
        self.merges: list[str] = []  # child runs that existed before being linked; server folds them in
        self._recent_llm: dict[tuple[str, str, int], float] = {}

    def _link(self, child_run: str, parent_run: str, agent_id: str) -> None:
        if child_run == parent_run or child_run in self.aliases:
            return
        self.aliases[child_run] = (parent_run, agent_id)
        if child_run in self.runs:
            self.merges.append(child_run)

    def drain_merges(self) -> list[str]:
        merges, self.merges = self.merges, []
        for child in merges:
            self.runs.pop(child, None)
        return merges

    def _is_duplicate_llm(self, ev: Event) -> bool:
        """Cursor fires afterAgentThought twice per thought (second generation_id has a suffix)."""
        if ev.event_type != "llm_end" or ev.data.get("kind") not in ("thought", "response") or not ev.data.get("output"):
            return False
        key = (ev.run_id, ev.source or "", hash(str(ev.data["output"])))
        seen = self._recent_llm.get(key)
        self._recent_llm[key] = ev.timestamp
        if len(self._recent_llm) > 2000:  # keep it bounded
            cutoff = ev.timestamp - 60_000
            self._recent_llm = {k: t for k, t in self._recent_llm.items() if t > cutoff}
        return seen is not None and ev.timestamp - seen < 60_000

    # -- helpers -----------------------------------------------------------------------------
    def _run(self, ev: Event) -> Run:
        run = self.runs.get(ev.run_id)
        if run is None:
            run = self.runs[ev.run_id] = Run(ev.run_id, ev.platform, ev.timestamp, ev.timestamp)
        return run

    def _agent(self, run: Run, agent_id: str, ts: float) -> Agent:
        agent = run.agents.get(agent_id)
        if agent is None:
            is_main = agent_id == MAIN
            agent = run.agents[agent_id] = Agent(
                id=agent_id, name=DISPLAY_NAMES.get(run.platform, "Agent") if is_main else agent_id,
                kind="main" if is_main else "agent", started_at=ts)
        agent.last_active = ts
        return agent

    def _resolve_subagent(self, run: Run, match: dict[str, Any]) -> str | None:
        """Pair a Cursor subagentStop (no id) with the oldest un-ended subagent matching task, then type.
        "Un-ended" (no agent_end yet), not "active": the stop expands to several events and the task_complete
        among them already flips the status before agent_end arrives."""
        active = sorted((a for a in run.agents.values() if a.kind == "subagent" and a.ended_at is None),
                        key=lambda a: a.started_at or 0)
        for pred in (lambda a: match.get("task") and a.current_task == match["task"],
                     lambda a: match.get("type") and a.name == match["type"]):
            for a in active:
                if pred(a):
                    return a.id
        return None

    def _has_active_children(self, run: Run, agent: Agent) -> bool:
        return any(a.parent == agent.id and a.status in ACTIVE for a in run.agents.values())

    def _busy(self, run: Run, agent: Agent, status: str) -> None:
        """Agent is doing work itself; it still shows `waiting` while any child it spawned is active."""
        agent.status = "waiting" if self._has_active_children(run, agent) else status

    def _settle_parent(self, run: Run, parent_id: str | None) -> None:
        parent = run.agents.get(parent_id or "")
        if parent and parent.status == "waiting" and not self._has_active_children(run, parent):
            parent.status = "running"

    def _latency(self, run: Run, ms: float | None) -> None:
        if ms is not None and ms >= 0:
            run.latency_total += ms
            run.latency_count += 1

    # -- reducer -----------------------------------------------------------------------------
    def apply(self, ev: Event) -> Run | None:
        """Mutates `ev` in place (alias / pairing resolution) so stored + broadcast events are canonical.
        Returns None when the event cannot be attributed and should be dropped."""
        parent_call = ev.data.get("parent_call")
        if parent_call and parent_call in self.subagent_runs:
            self._link(ev.run_id, self.subagent_runs[parent_call], parent_call)
        if ev.run_id in self.aliases:
            parent_run, agent_id = self.aliases[ev.run_id]
            ev.run_id = parent_run
            if ev.source in (None, MAIN):
                ev.source = agent_id
            if ev.target == USER:  # a subagent "replies" to whoever spawned it, not to the human
                ev.target = self.runs[parent_run].agents[agent_id].parent or MAIN

        run = self._run(ev)
        if ev.source is None and "match" in ev.data:
            ev.source = self._resolve_subagent(run, ev.data["match"])
            if ev.source is None:
                return None
            if ev.event_type in ("task_complete", "task_failed") and ev.task_id is None:
                ev.task_id = run.agents[ev.source].task_id
        if ev.data.get("child_run") and ev.source:
            self._link(ev.data["child_run"], run.run_id, ev.source)
        if self._is_duplicate_llm(ev):
            return None

        ts = ev.timestamp
        run.updated_at = max(run.updated_at, ts)
        run.event_count += 1
        agent = self._agent(run, ev.source, ts) if ev.source and ev.source != USER else None
        d = ev.data
        t = ev.event_type
        # observer attached mid-session (no run_start): pick context up from any event carrying it
        run.cwd = run.cwd or (d.get("cwd") if isinstance(d.get("cwd"), str) and d.get("cwd") else None)
        run.model = run.model or (d.get("model") if isinstance(d.get("model"), str) else None)

        if t == "run_start":
            run.cwd = d.get("cwd") or run.cwd
            run.model = d.get("model") or run.model
            run.title = d.get("title") or run.title
            run.ended_at = None

        elif t == "run_end":
            run.ended_at = ts
            run.end_status = ev.status or ("failed" if d.get("error") else "completed")
            for a in run.agents.values():
                if a.status in ACTIVE:
                    a.status = "completed" if run.end_status != "failed" else "failed"
                    a.ended_at = ts

        elif t == "agent_start" and agent:
            agent.name = d.get("name") or agent.name
            agent.kind = d.get("kind") or agent.kind
            agent.parent = d.get("parent") or agent.parent
            agent.model = d.get("model") or agent.model
            agent.status = ev.status or "running"
            agent.started_at, agent.ended_at = ts, None
            agent.input = _text(d.get("input")) or agent.input
            if agent.kind == "subagent":
                self.subagent_runs[agent.id] = run.run_id
            parent = run.agents.get(agent.parent or "")
            if parent and parent.status in ("planning", "running"):
                parent.status = "waiting"
                parent.current_action = f"waiting for {agent.name}"

        elif t == "agent_end" and agent:
            agent.status = ev.status or "completed"
            agent.ended_at = ts
            agent.current_action = None
            agent.output = _text(d.get("output")) or agent.output
            task = run.tasks.get(agent.task_id or "")
            if agent.status == "failed" and not (task and task.status == "failed"):  # task_failed already counted it
                run.errors += 1
                agent.errors += 1
            self._settle_parent(run, agent.parent)

        elif t == "agent_status" and agent:
            agent.status = ev.status or agent.status
            agent.current_action = _text(d.get("message"))

        elif t in ("task_create", "task_start") and agent:
            tid = ev.task_id or f"{agent.id}:{ev.event_id[:8]}"
            ev.task_id = tid
            task = run.tasks.get(tid) or Task(id=tid, agent=agent.id, created_at=ts)
            # Cursor: subagent id == id of the spawning Task call, whose short `description` beats the long prompt.
            spawn = run.open_calls.get(agent.id) if agent.kind == "subagent" else None
            title = _text(spawn["input"].get("description")) if spawn and isinstance(spawn.get("input"), dict) else None
            task.description = title or _text(d.get("description")) or task.description or agent.current_task or ""
            run.tasks[tid] = task
            if agent.id == MAIN and not run.title and task.description:
                run.title = task.description[:120]
            if t == "task_start":
                task.status, task.started_at = "running", ts
                agent.task_id, agent.current_task = tid, task.description or agent.current_task
                self._busy(run, agent, "planning")
                if agent.ended_at:
                    agent.ended_at = None

        elif t in ("task_complete", "task_failed") and agent:
            tid = ev.task_id or agent.task_id
            ev.task_id = tid
            task = run.tasks.get(tid or "")
            failed = t == "task_failed"
            status = "failed" if failed else (ev.status if ev.status == "aborted" else "completed")
            if task:
                task.status, task.ended_at = status, ts
                task.duration_ms = ev.duration_ms or (ts - task.started_at if task.started_at else None)
                task.error = _text(d.get("error"))
                ev.duration_ms = task.duration_ms
            agent.status = status
            agent.current_action = None
            agent.output = _text(d.get("output")) or agent.output
            if failed:
                run.errors += 1
                agent.errors += 1
            self._settle_parent(run, agent.parent)

        elif t == "agent_message":
            run.messages += 1
            if agent:
                agent.messages += 1
            if ev.target and ev.target != USER:
                target = self._agent(run, ev.target, ts)
                if d.get("content") is None and ev.source:
                    spawn = next((c for c in reversed(run.open_calls.values())
                                  if c["agent"] == ev.source and c["tool_name"] in SPAWN_TOOLS), None)
                    if spawn and isinstance(spawn.get("input"), dict):
                        inp = spawn["input"]
                        d["content"] = inp.get("prompt") or inp.get("description")
                        target.current_task = _text(inp.get("description")) or target.current_task
                        if inp.get("subagent_type"):
                            target.name = inp["subagent_type"]
                target.input = _text(d.get("content")) or target.input
            elif agent:
                agent.output = _text(d.get("content")) or agent.output

        elif t == "llm_start" and agent:
            if d.get("call_id"):
                run.open_calls[d["call_id"]] = {"agent": agent.id, "tool_name": None, "ts": ts, "input": d.get("input")}
            self._busy(run, agent, "running")
            agent.current_action = f"LLM: {d.get('model') or 'request'}"

        elif t == "llm_end" and agent:
            opened = run.open_calls.pop(d.get("call_id") or "", None)
            if ev.duration_ms is None and opened:
                ev.duration_ms = ts - opened["ts"]
            run.llm_calls += 1
            agent.llm_calls += 1
            self._latency(run, ev.duration_ms)
            tokens = d.get("total_tokens")
            if tokens is None and d.get("input_tokens") is not None and d.get("output_tokens") is not None:
                tokens = d["input_tokens"] + d["output_tokens"]
            if isinstance(tokens, (int, float)):
                run.tokens = (run.tokens or 0) + int(tokens)
                agent.tokens = (agent.tokens or 0) + int(tokens)
            if ev.status == "failed":
                run.errors += 1
                agent.errors += 1
            if agent.current_action and agent.current_action.startswith("LLM"):
                agent.current_action = None

        elif t == "tool_start" and agent:
            call_id = d.get("call_id") or ev.event_id
            d["call_id"] = call_id
            run.open_calls[call_id] = {"agent": agent.id, "tool_name": d.get("tool_name"), "ts": ts, "input": d.get("input")}
            run.tool_calls += 1
            agent.tool_calls += 1
            self._busy(run, agent, "running")
            agent.current_action = _describe_call(d)

        elif t == "tool_end" and agent:
            call_id = d.get("call_id") or next(  # producer without ids: newest open call of this agent+tool
                (k for k, c in reversed(run.open_calls.items())
                 if c["agent"] == agent.id and c["tool_name"] == d.get("tool_name")), "")
            opened = run.open_calls.pop(call_id, None)
            if call_id:
                d["call_id"] = call_id
            if opened is None:  # end without start (observer attached mid-call)
                run.tool_calls += 1
                agent.tool_calls += 1
            else:
                d.setdefault("input", opened.get("input"))
                if ev.duration_ms is None:
                    ev.duration_ms = ts - opened["ts"]
            self._latency(run, ev.duration_ms)
            if ev.status == "failed":
                run.errors += 1
                agent.errors += 1
            if agent.status != "waiting":
                agent.current_action = None

        elif t == "error":
            run.errors += 1
            if agent:
                agent.errors += 1
                if ev.status == "failed":
                    agent.status = "failed"

        return run

    def is_turn_end(self, ev: Event) -> bool:
        """A root-agent turn finished (or the whole run ended): the moment to report progress."""
        return ev.event_type == "run_end" or (
            ev.event_type in ("task_complete", "task_failed") and ev.source == MAIN)
