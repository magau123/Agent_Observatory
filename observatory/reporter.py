"""Progress reports: one per finished agent turn, plus a periodic digest. Shown in the dashboard and as
desktop notifications. Everything is computed from recorded events - nothing is estimated."""

from __future__ import annotations

import base64
import logging
import os
import subprocess
import sys
import time
import uuid
from pathlib import PurePath
from typing import Any
from xml.sax.saxutils import escape

from .adapters import DISPLAY_NAMES
from .schema import USER, Event
from .state import Run

log = logging.getLogger("observatory.reporter")

NOTIFY = os.environ.get("OBSERVATORY_NOTIFY", "1") != "0"
NOTIFY_MIN_TURN_S = float(os.environ.get("OBSERVATORY_NOTIFY_MIN_SECONDS", "20"))
PS_APP_ID = r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"


def _dur(ms: float | None) -> str:
    if ms is None:
        return "N/A"
    s = ms / 1000
    return f"{s:.1f}s" if s < 60 else f"{int(s // 60)}m{int(s % 60):02d}s"


def _project(run: Run) -> str:
    return PurePath(run.cwd).name if run.cwd else run.run_id.split(":", 1)[-1][:8]


def _label(run: Run) -> str:
    return f"[{DISPLAY_NAMES.get(run.platform, run.platform)}] {_project(run)}"


def _stats(events: list[Event]) -> dict[str, Any]:
    tools = [e for e in events if e.event_type == "tool_start"]
    failed = [e for e in events if e.event_type in ("tool_end", "llm_end", "task_failed", "agent_end", "error")
              and e.status == "failed"]
    subs = {e.source for e in events if e.event_type == "agent_start" and e.data.get("kind") == "subagent"}
    top: dict[str, int] = {}
    for e in tools:
        name = str(e.data.get("tool_name"))
        top[name] = top.get(name, 0) + 1
    return {"tools": len(tools), "failed": failed, "subagents": len(subs),
            "top_tools": sorted(top.items(), key=lambda kv: -kv[1])[:5]}


def _make(kind: str, title: str, body: str, lines: list[str], run: Run | None = None) -> dict[str, Any]:
    return {"id": uuid.uuid4().hex, "ts": time.time() * 1000, "kind": kind, "title": title, "body": body,
            "lines": lines, "run_id": run.run_id if run else None, "platform": run.platform if run else None}


def turn_report(run: Run, ev: Event, events: list[Event]) -> dict[str, Any]:
    """Report for one finished root-agent turn (`events` = the turn's events)."""
    st = _stats(events)
    task = run.tasks.get(ev.task_id or "")
    outcome = {"task_failed": "失败", "run_end": "会话结束"}.get(ev.event_type) or (
        "已中止" if ev.status == "aborted" else "完成")
    reply = next((e.data.get("content") for e in reversed(events)
                  if e.event_type == "agent_message" and e.target == USER and e.data.get("content")), None)
    body = f"用时 {_dur(task.duration_ms if task else ev.duration_ms)}，工具调用 {st['tools']} 次" \
           f"（失败 {len(st['failed'])}），子 agent {st['subagents']} 个"
    lines = []
    if task and task.description:
        lines.append(f"任务：{task.description[:200]}")
    if st["top_tools"]:
        lines.append("常用工具：" + "，".join(f"{n}×{c}" for n, c in st["top_tools"]))
    for e in st["failed"][:5]:
        lines.append(f"错误：{e.source} {e.data.get('tool_name') or e.event_type} - {str(e.data.get('error'))[:160]}")
    if reply:
        lines.append(f"最终回复：{str(reply)[:300]}")
    return _make("turn", f"{_label(run)} 任务{outcome}", body, lines, run)


def digest_report(runs: list[tuple[Run, list[Event]]], window_min: float, kind: str = "periodic") -> dict[str, Any] | None:
    """Digest over runs with activity in the window. Returns None when nothing happened."""
    if not runs:
        return None
    lines: list[str] = []
    total_tools = total_err = 0
    for run, events in runs:
        st = _stats(events)
        total_tools += st["tools"]
        total_err += len(st["failed"])
        m = run.metrics()
        lines.append(f"{_label(run)} · {run.status} · 活跃 agent {m['active_agents']}/{m['total_agents']} · "
                     f"工具 {st['tools']} 次 · 错误 {len(st['failed'])} · {(run.title or '')[:60]}")
        active = [a for a in run.agents.values() if a.status in ("planning", "running", "waiting")]
        for a in active[:4]:
            lines.append(f"    ↳ {a.name}（{a.status}）：{(a.current_action or a.current_task or '')[:100]}")
    running = sum(r.status == "running" for r, _ in runs)
    body = f"近 {window_min:g} 分钟：{len(runs)} 个会话（{running} 个运行中），工具调用 {total_tools} 次，错误 {total_err} 个"
    return _make(kind, "Agent Observatory 进度汇总", body, lines)


def notify(title: str, body: str, url: str) -> None:
    """Fire-and-forget desktop notification; failures are logged, never raised."""
    if not NOTIFY:
        return
    try:
        if sys.platform == "win32":
            xml = (f'<toast activationType="protocol" launch="{escape(url)}"><visual><binding template="ToastGeneric">'
                   f"<text>{escape(title)}</text><text>{escape(body)}</text></binding></visual></toast>")
            script = (
                "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null;"
                "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] > $null;"
                "$x = New-Object Windows.Data.Xml.Dom.XmlDocument;"
                f"$x.LoadXml(@'\n{xml}\n'@);"
                f"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{PS_APP_ID}')"
                ".Show([Windows.UI.Notifications.ToastNotification]::new($x))"
            )
            encoded = base64.b64encode(script.encode("utf-16-le")).decode()
            subprocess.Popen(["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             creationflags=subprocess.CREATE_NO_WINDOW)  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            safe = lambda s: s.replace("\\", "\\\\").replace('"', '\\"')  # noqa: E731
            subprocess.Popen(["osascript", "-e", f'display notification "{safe(body)}" with title "{safe(title)}"'])
        else:
            subprocess.Popen(["notify-send", title, body])
    except Exception as exc:  # noqa: BLE001
        log.warning("desktop notification failed: %r", exc)


def should_notify_turn(report: dict[str, Any], run: Run, ev: Event) -> bool:
    task = run.tasks.get(ev.task_id or "")
    long_enough = task is None or (task.duration_ms or 0) >= NOTIFY_MIN_TURN_S * 1000
    return long_enough or ev.event_type == "task_failed" or "失败" in report["title"]
