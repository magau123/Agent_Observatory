"""FastAPI app: hook ingestion, SDK event ingestion, REST queries, WebSocket live stream, reports."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from . import reporter
from .adapters import adapt
from .hub import Hub
from .schema import Event
from .state import Run, RuntimeState
from .store import Store

log = logging.getLogger("observatory")


def create_app(db_path: Path, report_interval_min: float = 30, public_url: str = "http://127.0.0.1:7777",
               static_dir: Path | None = None) -> FastAPI:
    state = RuntimeState()
    store = Store(db_path)
    hub = Hub()
    replayed = 0
    for ev in store.all_events():
        state.apply(ev)
        replayed += 1
    state.drain_merges()  # stored events were already rewritten when the merge first happened
    log.info("replayed %d stored events into %d runs", replayed, len(state.runs))

    async def fold_linked_runs() -> None:
        """A subagent conversation seen before its link to the parent run: move its events over."""
        for child in state.drain_merges():
            moved = store.run_events(child, limit=10**9)
            store.delete_run(child)
            await hub.broadcast({"type": "run_removed", "run_id": child})
            parent = None
            for old in moved:  # alias is registered now, so apply() rewrites run/source like a live event
                parent = state.apply(old) or parent
                store.add_event(old)
            if parent:
                log.info("folded %d events of %s into %s", len(moved), child, parent.run_id)
                await hub.broadcast({"type": "run_updated", "run": parent.snapshot()})

    async def publish_report(report: dict[str, Any] | None, toast: bool) -> None:
        if report is None:
            return
        store.add_report(report)
        await hub.broadcast({"type": "report", "report": report})
        if toast:
            await asyncio.to_thread(reporter.notify, report["title"], report["body"], public_url)

    async def report_turn(run: Run, ev: Event) -> None:
        task = run.tasks.get(ev.task_id or "")
        since = (task.started_at or task.created_at) if task else run.started_at
        report = reporter.turn_report(run, ev, store.run_events(run.run_id, since, ev.timestamp))
        await publish_report(report, reporter.should_notify_turn(report, run, ev))

    def digest(window_min: float, kind: str) -> dict[str, Any] | None:
        since = time.time() * 1000 - window_min * 60_000
        active = [(r, store.run_events(r.run_id, since)) for r in state.runs.values() if r.updated_at >= since]
        return reporter.digest_report(active, window_min, kind)

    async def ingest(events: list[Event]) -> int:
        accepted = 0
        for ev in events:
            try:
                run = state.apply(ev)
            except Exception:  # noqa: BLE001 - one bad event must not break the stream
                log.exception("failed to apply event %s", ev.event_type)
                continue
            if run is None:
                log.info("dropped unattributable %s event in %s", ev.event_type, ev.run_id)
                continue
            store.add_event(ev)
            accepted += 1
            await hub.broadcast({"type": "event", "event": ev.model_dump(), "run": run.snapshot()})
            if state.merges:
                await fold_linked_runs()
            if state.is_turn_end(ev):
                try:
                    await report_turn(run, ev)
                except Exception:  # noqa: BLE001
                    log.exception("turn report failed")
        return accepted

    async def periodic() -> None:
        while True:
            await asyncio.sleep(report_interval_min * 60)
            try:
                await publish_report(digest(report_interval_min, "periodic"), toast=False)
            except Exception:  # noqa: BLE001
                log.exception("periodic report failed")

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        task = asyncio.create_task(periodic()) if report_interval_min > 0 else None
        yield
        if task:
            task.cancel()

    app = FastAPI(title="Agent Observatory", lifespan=lifespan)

    @app.post("/api/hooks/{platform}")
    async def hook(platform: str, payload: dict[str, Any] = Body(...)) -> dict[str, int]:
        try:
            events = adapt(platform, payload)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except ValidationError as exc:
            log.warning("bad %s hook payload (%s): %s", platform, payload.get("hook_event_name"), exc)
            raise HTTPException(422, "payload could not be normalized") from exc
        return {"accepted": await ingest(events)}

    @app.post("/api/events")
    async def post_events(body: list[Event] | Event = Body(...)) -> dict[str, int]:
        return {"accepted": await ingest(body if isinstance(body, list) else [body])}

    @app.get("/api/runs")
    def runs() -> list[dict[str, Any]]:
        return sorted((r.summary() for r in state.runs.values()), key=lambda r: -r["updated_at"])

    @app.get("/api/runs/{run_id}")
    def run(run_id: str) -> dict[str, Any]:
        if run_id not in state.runs:
            raise HTTPException(404, "run not found")
        return state.runs[run_id].snapshot()

    @app.get("/api/runs/{run_id}/events")
    def run_events(run_id: str, limit: int = 5000) -> list[dict[str, Any]]:
        return [e.model_dump() for e in store.run_events(run_id, limit=min(limit, 20000))]

    @app.delete("/api/runs/{run_id}")
    async def delete_run(run_id: str) -> dict[str, bool]:
        state.runs.pop(run_id, None)
        store.delete_run(run_id)
        await hub.broadcast({"type": "run_removed", "run_id": run_id})
        return {"ok": True}

    @app.get("/api/reports")
    def reports(limit: int = 50) -> list[dict[str, Any]]:
        return store.reports(limit)

    @app.post("/api/reports/now")
    async def report_now(window_min: float = 60) -> dict[str, Any]:
        report = digest(window_min, "manual") or reporter.digest_report([], window_min)
        if report is None:
            return {"title": "Agent Observatory", "body": f"近 {window_min:g} 分钟没有 agent 活动", "lines": []}
        await publish_report(report, toast=False)
        return report

    @app.get("/api/schema")
    def schema() -> dict[str, Any]:
        return Event.model_json_schema()

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "runs": len(state.runs), "clients": len(hub.clients)}

    @app.websocket("/ws")
    async def ws(socket: WebSocket) -> None:
        try:
            await hub.connect(socket, {"type": "hello", "runs": runs(), "reports": store.reports(20)})
            while True:
                await socket.receive_text()  # clients don't send commands; this detects disconnects
        except WebSocketDisconnect:
            pass
        except Exception as exc:  # noqa: BLE001
            log.warning("websocket error: %r", exc)
        finally:
            hub.disconnect(socket)

    if static_dir and static_dir.is_dir():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="dashboard")
    return app
