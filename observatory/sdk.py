"""Instrument any Python multi-agent app (LangGraph, CrewAI, AutoGen, hand-rolled...) for Agent Observatory.

Standard library only - copy this single file into another project if you like.

    from observatory.sdk import Tracer
    tr = Tracer(title="Analyze document")
    with tr.agent("planner") as planner:
        with tr.task(planner, "split work"):
            with tr.llm(planner, model="gpt-4o", input=prompt) as call:
                call.output, call.input_tokens, call.output_tokens = ...
            tr.message(planner, "researcher", "look up X")
    tr.end()

Events are queued and POSTed by a daemon thread, so instrumentation never blocks the host app; if the
server is down events are dropped (logged at debug level) and the host app keeps running.
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import queue
import threading
import time
import urllib.request
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator

log = logging.getLogger("observatory.sdk")


@dataclass
class Call:
    """Filled in by the caller inside `tool()` / `llm()` blocks. Unset token fields stay N/A."""
    output: Any = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None


def _err(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"


class Tracer:
    def __init__(self, title: str | None = None, run_id: str | None = None, url: str | None = None,
                 platform: str = "sdk") -> None:
        self.run_id = run_id or f"run_{uuid.uuid4().hex[:10]}"
        self.platform = platform
        self.url = (url or os.environ.get("OBSERVATORY_URL", "http://127.0.0.1:7777")).rstrip("/") + "/api/events"
        self._q: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=10_000)
        threading.Thread(target=self._worker, daemon=True, name="observatory-sdk").start()
        atexit.register(self.flush)
        self.emit("run_start", data={"title": title, "cwd": os.getcwd()})

    # -- transport ---------------------------------------------------------------------------
    def emit(self, event_type: str, *, source: str | None = None, target: str | None = None,
             task_id: str | None = None, status: str | None = None, data: dict[str, Any] | None = None,
             duration_ms: float | None = None) -> None:
        event = {"event_id": uuid.uuid4().hex, "timestamp": time.time() * 1000, "event_type": event_type,
                 "platform": self.platform, "run_id": self.run_id, "task_id": task_id, "source": source,
                 "target": target, "status": status, "data": data or {}, "duration_ms": duration_ms}
        try:
            self._q.put_nowait(event)
        except queue.Full:
            log.debug("observatory queue full, dropping %s", event_type)

    def _worker(self) -> None:
        while True:
            batch = [self._q.get()]
            while len(batch) < 200:
                try:
                    batch.append(self._q.get_nowait())
                except queue.Empty:
                    break
            try:
                body = json.dumps(batch, default=str).encode()
                req = urllib.request.Request(self.url, data=body, headers={"Content-Type": "application/json"})
                urllib.request.urlopen(req, timeout=3).close()
            except Exception as exc:  # noqa: BLE001
                log.debug("observatory unreachable, dropped %d events: %r", len(batch), exc)
            finally:
                for _ in batch:
                    self._q.task_done()

    def flush(self, timeout: float = 3.0) -> None:
        deadline = time.monotonic() + timeout
        while self._q.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.02)

    def end(self, status: str = "completed", error: str | None = None) -> None:
        self.emit("run_end", status=status, data={"error": error} if error else {})
        self.flush()

    # -- instrumentation helpers -------------------------------------------------------------
    @contextmanager
    def agent(self, name: str, *, parent: str | None = None, input: Any = None,
              agent_id: str | None = None) -> Iterator[str]:
        aid = agent_id or name
        self.emit("agent_start", source=aid, data={"name": name, "parent": parent, "input": input, "kind": "agent"})
        t0 = time.perf_counter()
        try:
            yield aid
        except BaseException as exc:
            self.emit("agent_end", source=aid, status="failed", duration_ms=(time.perf_counter() - t0) * 1000,
                      data={"error": _err(exc)})
            raise
        self.emit("agent_end", source=aid, status="completed", duration_ms=(time.perf_counter() - t0) * 1000)

    @contextmanager
    def task(self, agent: str, description: str, task_id: str | None = None) -> Iterator[str]:
        tid = task_id or f"task_{uuid.uuid4().hex[:8]}"
        self.emit("task_create", source=agent, task_id=tid, data={"description": description})
        self.emit("task_start", source=agent, task_id=tid, data={"description": description})
        try:
            yield tid
        except BaseException as exc:
            self.emit("task_failed", source=agent, task_id=tid, status="failed", data={"error": _err(exc)})
            raise
        self.emit("task_complete", source=agent, task_id=tid, status="completed")

    @contextmanager
    def tool(self, agent: str, name: str, input: Any = None) -> Iterator[Call]:
        call_id, call = uuid.uuid4().hex, Call()
        self.emit("tool_start", source=agent, data={"call_id": call_id, "tool_name": name, "input": input})
        t0 = time.perf_counter()
        try:
            yield call
        except BaseException as exc:
            self.emit("tool_end", source=agent, status="failed", duration_ms=(time.perf_counter() - t0) * 1000,
                      data={"call_id": call_id, "tool_name": name, "error": _err(exc)})
            raise
        self.emit("tool_end", source=agent, status="completed", duration_ms=(time.perf_counter() - t0) * 1000,
                  data={"call_id": call_id, "tool_name": name, "output": call.output})

    @contextmanager
    def llm(self, agent: str, model: str, input: Any = None) -> Iterator[Call]:
        call_id, call = uuid.uuid4().hex, Call()
        self.emit("llm_start", source=agent, data={"call_id": call_id, "model": model, "input": input})
        t0 = time.perf_counter()
        try:
            yield call
        except BaseException as exc:
            self.emit("llm_end", source=agent, status="failed", duration_ms=(time.perf_counter() - t0) * 1000,
                      data={"call_id": call_id, "model": model, "error": _err(exc)})
            raise
        self.emit("llm_end", source=agent, status="completed", duration_ms=(time.perf_counter() - t0) * 1000,
                  data={"call_id": call_id, "model": model, "output": call.output, "input_tokens": call.input_tokens,
                        "output_tokens": call.output_tokens, "total_tokens": call.total_tokens})

    def message(self, source: str, target: str, content: Any) -> None:
        self.emit("agent_message", source=source, target=target, data={"content": content})

    def error(self, agent: str | None, message: str, fatal: bool = False) -> None:
        self.emit("error", source=agent, status="failed" if fatal else None, data={"error": message})
