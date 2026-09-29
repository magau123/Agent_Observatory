"""Translate raw hook payloads from coding-agent tools into unified `Event`s.

Adapters are stateless: anything that needs history (pairing a subagentStop with its subagentStart,
filling a spawn message from the pending Task tool call) is resolved in `state.RuntimeState`.
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Callable

from .schema import MAIN, USER, Event

DISPLAY_NAMES = {"cursor": "Cursor Agent", "claude-code": "Claude Code", "codex": "Codex"}
PLATFORM_ALIASES = {"claude": "claude-code", "claude-code": "claude-code", "codex": "codex", "cursor": "cursor"}


def _drop_none(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def _looks_failed(response: Any) -> str | None:
    """Codex has no PostToolUseFailure hook, so infer failures from the tool response shape."""
    if not isinstance(response, dict):
        return None
    for key in ("exit_code", "exitCode"):
        code = response.get(key)
        if isinstance(code, int) and code != 0:
            return f"exit code {code}"
    if response.get("is_error") or response.get("success") is False:
        return str(response.get("error") or response.get("stderr") or "tool reported failure")
    return None


def _claude_style(platform: str, p: dict[str, Any]) -> list[Event]:
    """Claude Code and Codex share the same hook vocabulary and field names."""
    name = p.get("hook_event_name")
    run = f"{platform}:{p.get('session_id') or 'unknown'}"
    agent = p.get("agent_id") or MAIN  # hooks fired inside a subagent carry its agent_id
    turn = p.get("turn_id")

    def ev(event_type: str, **kw: Any) -> Event:
        return Event(event_type=event_type, platform=platform, run_id=run, **kw)  # type: ignore[arg-type]

    if name == "SessionStart":
        return [
            ev("run_start", data=_drop_none({"cwd": p.get("cwd"), "model": p.get("model"), "source": p.get("source")})),
            ev("agent_start", source=MAIN, status="idle",
               data=_drop_none({"name": DISPLAY_NAMES[platform], "kind": "main", "model": p.get("model")})),
        ]
    if name == "UserPromptSubmit":
        prompt = p.get("prompt") or ""
        tid = turn or uuid.uuid4().hex[:12]  # Claude has no turn_id; Stop falls back to the agent's current task
        return [
            ev("agent_message", source=USER, target=MAIN, data={"content": prompt}),
            ev("task_create", source=MAIN, task_id=tid, data=_drop_none({"description": prompt, "cwd": p.get("cwd")})),
            ev("task_start", source=MAIN, task_id=tid, data={"description": prompt}),
        ]
    if name == "PreToolUse":
        return [ev("tool_start", source=agent, task_id=turn, data=_drop_none({
            "call_id": p.get("tool_use_id"), "tool_name": p.get("tool_name"), "input": p.get("tool_input"),
            "cwd": p.get("cwd"), "model": p.get("model")}))]
    if name == "PostToolUse":
        error = _looks_failed(p.get("tool_response"))
        return [ev("tool_end", source=agent, task_id=turn, status="failed" if error else "completed", data=_drop_none({
            "call_id": p.get("tool_use_id"), "tool_name": p.get("tool_name"),
            "output": p.get("tool_response"), "error": error}))]
    if name == "PostToolUseFailure":
        return [ev("tool_end", source=agent, task_id=turn, status="aborted" if p.get("is_interrupt") else "failed", data={
            "call_id": p.get("tool_use_id"), "tool_name": p.get("tool_name"), "error": p.get("error") or "tool failed"})]
    if name in ("Notification", "PermissionRequest"):
        return [ev("agent_status", source=agent, status="waiting",
                   data={"message": p.get("message") or f"permission requested: {p.get('tool_name')}"})]
    if name == "SubagentStart":
        sub = p.get("agent_id") or "subagent"
        return [
            ev("agent_start", source=sub, status="running",
               data={"name": p.get("agent_type") or "subagent", "kind": "subagent", "parent": MAIN}),
            ev("agent_message", source=MAIN, target=sub, data={"content": None}),  # state fills from the Task call
            ev("task_start", source=sub, task_id=f"sub:{sub}"),
        ]
    if name == "SubagentStop":
        sub = p.get("agent_id") or "subagent"
        out = p.get("last_assistant_message")
        return [
            ev("agent_message", source=sub, target=MAIN, data={"content": out}),
            ev("task_complete", source=sub, task_id=f"sub:{sub}"),
            ev("agent_end", source=sub, status="completed", data=_drop_none({"output": out})),
        ]
    if name == "Stop":
        out = p.get("last_assistant_message")
        msgs = [ev("agent_message", source=MAIN, target=USER, data={"content": out})] if out else []
        return msgs + [ev("task_complete", source=MAIN, task_id=turn, data=_drop_none({"output": out}))]
    if name == "SessionEnd":
        return [ev("run_end", data=_drop_none({"reason": p.get("reason")}))]
    return []


def _json_or_raw(value: Any) -> Any:
    """Cursor subagents send tool_input as a JSON string; parse it so the UI can show fields."""
    if isinstance(value, str) and value[:1] in "{[":
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def _cursor(p: dict[str, Any]) -> list[Event]:
    events = _cursor_events(p)
    # Subagent conversations report under their own conversation_id; tool events carry the spawning
    # Task call id, which is the parent-side subagent id. State uses it to fold them into the parent run.
    if p.get("parent_tool_call_id"):
        for e in events:
            e.data["parent_call"] = p["parent_tool_call_id"]
    return events


def _cursor_events(p: dict[str, Any]) -> list[Event]:
    name = p.get("hook_event_name")
    conv = p.get("parent_conversation_id") or p.get("conversation_id") or p.get("session_id") or "unknown"
    run = f"cursor:{conv}"
    gen = p.get("generation_id")
    roots = p.get("workspace_roots") or []
    cwd = p.get("cwd") or (roots[0] if roots else None)

    def ev(event_type: str, **kw: Any) -> Event:
        return Event(event_type=event_type, platform="cursor", run_id=run, **kw)  # type: ignore[arg-type]

    if name == "sessionStart":
        return [
            ev("run_start", data=_drop_none({"cwd": cwd, "model": p.get("model"), "mode": p.get("composer_mode"),
                                             "background": p.get("is_background_agent")})),
            ev("agent_start", source=MAIN, status="idle",
               data=_drop_none({"name": DISPLAY_NAMES["cursor"], "kind": "main", "model": p.get("model")})),
        ]
    if name == "beforeSubmitPrompt":
        prompt = p.get("prompt") or ""
        return [
            ev("agent_message", source=USER, target=MAIN, data={"content": prompt}),
            ev("task_create", source=MAIN, task_id=gen, data=_drop_none({"description": prompt, "cwd": cwd,
                                                                         "model": p.get("model")})),
            ev("task_start", source=MAIN, task_id=gen, data={"description": prompt}),
        ]
    if name == "preToolUse":
        return [ev("tool_start", source=MAIN, task_id=gen, data=_drop_none({
            "call_id": p.get("tool_use_id"), "tool_name": p.get("tool_name"), "input": _json_or_raw(p.get("tool_input")),
            "intent": p.get("agent_message"), "cwd": cwd, "model": p.get("model")}))]
    if name == "postToolUse":
        return [ev("tool_end", source=MAIN, task_id=gen, status="completed", duration_ms=p.get("duration"), data={
            "call_id": p.get("tool_use_id"), "tool_name": p.get("tool_name"),
            "output": _json_or_raw(p.get("tool_output"))})]
    if name == "postToolUseFailure":
        return [ev("tool_end", source=MAIN, task_id=gen, status="aborted" if p.get("is_interrupt") else "failed",
                   duration_ms=p.get("duration"), data=_drop_none({
                       "call_id": p.get("tool_use_id"), "tool_name": p.get("tool_name"),
                       "error": p.get("error_message") or "tool failed", "failure_type": p.get("failure_type")}))]
    if name == "subagentStart":
        sub = p.get("subagent_id") or p.get("tool_call_id") or "subagent"
        task = p.get("task") or ""
        return [
            ev("agent_start", source=sub, status="running", data=_drop_none({
                "name": p.get("subagent_type") or "subagent", "kind": "subagent", "parent": MAIN,
                "model": p.get("subagent_model"), "parallel": p.get("is_parallel_worker")})),
            ev("agent_message", source=MAIN, target=sub, data={"content": task}),
            ev("task_start", source=sub, task_id=f"sub:{sub}", data={"description": task}),
        ]
    if name == "subagentStop":
        # subagentStop does not document subagent_id; state resolves by task text / type when absent.
        sub = p.get("subagent_id")
        match = {"task": p.get("task"), "type": p.get("subagent_type")}
        status = {"completed": "completed", "error": "failed", "aborted": "aborted"}.get(p.get("status") or "", "completed")
        summary = p.get("summary")
        common: dict[str, Any] = {"match": match} if not sub else {}
        child = {"child_run": f"cursor:{p['child_conversation_id']}"} if p.get("child_conversation_id") else {}
        return [
            ev("agent_message", source=sub, target=MAIN, data={**common, **child, "content": summary}),
            ev("task_failed" if status == "failed" else "task_complete", source=sub,
               task_id=f"sub:{sub}" if sub else None, status=status, duration_ms=p.get("duration_ms"),
               data={**common, **_drop_none({"output": summary, "modified_files": p.get("modified_files")})}),
            ev("agent_end", source=sub, status=status, duration_ms=p.get("duration_ms"), data={**common, **_drop_none({
                "output": summary, "tool_call_count": p.get("tool_call_count"),
                "message_count": p.get("message_count")})}),
        ]
    if name == "afterAgentThought":
        return [ev("llm_end", source=MAIN, task_id=gen, status="completed", duration_ms=p.get("duration_ms"),
                   data=_drop_none({"kind": "thought", "model": p.get("model"), "output": p.get("text")}))]
    if name == "afterAgentResponse":
        text = p.get("text")
        return [
            ev("llm_end", source=MAIN, task_id=gen, status="completed",
               data=_drop_none({"kind": "response", "model": p.get("model"), "output": text})),
            ev("agent_message", source=MAIN, target=USER, data={"content": text}),
        ]
    if name == "stop":
        status = p.get("status") or "completed"
        if status == "error":
            return [ev("task_failed", source=MAIN, task_id=gen, status="failed", data={"error": "agent loop ended with error"})]
        return [ev("task_complete", source=MAIN, task_id=gen, status="aborted" if status == "aborted" else "completed")]
    if name == "sessionEnd":
        return [ev("run_end", duration_ms=p.get("duration_ms"), status="failed" if p.get("reason") == "error" else None,
                   data=_drop_none({"reason": p.get("reason"), "error": p.get("error_message")}))]
    return []


ADAPTERS: dict[str, Callable[[dict[str, Any]], list[Event]]] = {
    "cursor": _cursor,
    "claude-code": lambda p: _claude_style("claude-code", p),
    "codex": lambda p: _claude_style("codex", p),
}


def adapt(platform: str, payload: dict[str, Any]) -> list[Event]:
    key = PLATFORM_ALIASES.get(platform)
    if key is None:
        raise ValueError(f"unknown platform: {platform}")
    return ADAPTERS[key](payload)
