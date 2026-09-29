"""End-to-end check: real server, real hook script subprocesses, real SDK demo, real WebSocket.

    python tests/test_observatory.py
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ["OBSERVATORY_NOTIFY"] = "0"

import uvicorn  # noqa: E402
import websockets  # noqa: E402

from observatory.server import create_app  # noqa: E402

HOOK = ROOT / "hooks" / "observe_hook.py"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


PORT = free_port()
BASE = f"http://127.0.0.1:{PORT}"


def get(path: str) -> Any:
    with urllib.request.urlopen(BASE + path, timeout=5) as r:
        return json.load(r)


def post(path: str, body: Any) -> int:
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def hook(platform: str, payload: dict[str, Any]) -> None:
    out = subprocess.run([sys.executable, str(HOOK), platform], input=json.dumps(payload).encode(),
                         capture_output=True, env={**os.environ, "OBSERVATORY_URL": BASE}, timeout=10)
    assert out.returncode == 0 and out.stdout == b"{}", out


def agents(run_id: str) -> dict[str, dict[str, Any]]:
    return {a["id"]: a for a in get(f"/api/runs/{run_id}")["agents"]}


def test_cursor() -> None:
    c = {"conversation_id": "c1", "generation_id": "g1", "model": "opus", "workspace_roots": ["E:/proj/demo"]}
    hook("cursor", {**c, "hook_event_name": "sessionStart", "session_id": "c1", "composer_mode": "agent"})
    hook("cursor", {**c, "hook_event_name": "beforeSubmitPrompt", "prompt": "refactor auth"})
    hook("cursor", {**c, "hook_event_name": "preToolUse", "tool_name": "Read", "tool_use_id": "t1",
                    "tool_input": {"file_path": "a.py"}})
    hook("cursor", {**c, "hook_event_name": "postToolUse", "tool_name": "Read", "tool_use_id": "t1",
                    "tool_output": "{}", "duration": 12})
    for sid, task in (("s1", "explore auth"), ("s2", "explore db")):  # parallel subagents
        hook("cursor", {**c, "hook_event_name": "subagentStart", "subagent_id": sid, "subagent_type": "explore",
                        "task": task, "parent_conversation_id": "c1", "is_parallel_worker": True})
    assert agents("cursor:c1")["main"]["status"] == "waiting"
    # Real Cursor 3.22 shape: subagent s2 reports under its own conversation. An early thought arrives before
    # anything links it (and, like Cursor does, twice); the tool call carries parent_tool_call_id = s2.
    child = {"conversation_id": "child-2", "generation_id": "cg"}
    for gen in ("cg", "cg-0-ab12"):
        hook("cursor", {**child, "generation_id": gen, "hook_event_name": "afterAgentThought", "text": "check db", "duration_ms": 5})
    hook("cursor", {**child, "parent_tool_call_id": "s2", "hook_event_name": "postToolUseFailure", "tool_name": "Shell",
                    "tool_use_id": "t2", "error_message": "timeout", "failure_type": "timeout", "duration": 30000})
    assert all(r["run_id"] != "cursor:child-2" for r in get("/api/runs")), "child run should be folded into parent"
    hook("cursor", {**c, "hook_event_name": "subagentStop", "subagent_id": "s2", "child_conversation_id": "child-2",
                    "subagent_type": "explore", "status": "completed", "task": "explore db", "summary": "done explore db"})
    hook("cursor", {**c, "hook_event_name": "subagentStop", "subagent_type": "explore", "status": "completed",
                    "task": "explore auth", "summary": "done explore auth", "duration_ms": 900})  # documented: no id
    hook("cursor", {**c, "hook_event_name": "afterAgentResponse", "text": "Refactored."})
    hook("cursor", {**c, "hook_event_name": "stop", "status": "completed", "loop_count": 0})

    run = get("/api/runs/cursor:c1")
    a = {x["id"]: x for x in run["agents"]}
    assert set(a) == {"main", "s1", "s2"}, a.keys()
    assert a["s1"]["output"] == "done explore auth" and a["s2"]["output"] == "done explore db", a
    assert a["s2"]["errors"] == 1 and a["s1"]["errors"] == 0
    assert a["s2"]["llm_calls"] == 1 and a["s2"]["tool_calls"] == 1, a["s2"]  # folded + deduplicated
    assert a["main"]["status"] == "completed" and run["status"] == "idle"
    assert run["title"] == "refactor auth" and run["cwd"] == "E:/proj/demo"
    m = run["metrics"]
    assert (m["tool_calls"], m["errors"], m["llm_calls"], m["total_tokens"]) == (2, 1, 2, None), m
    assert any(r["run_id"] == "cursor:c1" and r["kind"] == "turn" for r in get("/api/reports"))


def test_claude_and_codex() -> None:
    s = {"session_id": "k1", "cwd": "/w/app", "transcript_path": None}
    hook("claude", {**s, "hook_event_name": "SessionStart", "source": "startup", "model": "sonnet"})
    hook("claude", {**s, "hook_event_name": "UserPromptSubmit", "prompt": "add tests"})
    hook("claude", {**s, "hook_event_name": "PreToolUse", "tool_name": "Task", "tool_use_id": "u1",
                    "tool_input": {"description": "write tests", "prompt": "write pytest cases", "subagent_type": "tester"}})
    hook("claude", {**s, "hook_event_name": "SubagentStart", "agent_id": "a1", "agent_type": "tester"})
    hook("claude", {**s, "hook_event_name": "PreToolUse", "agent_id": "a1", "tool_name": "Bash", "tool_use_id": "u2",
                    "tool_input": {"command": "pytest"}})
    hook("claude", {**s, "hook_event_name": "PostToolUse", "agent_id": "a1", "tool_name": "Bash", "tool_use_id": "u2",
                    "tool_response": {"stdout": "ok"}})
    hook("claude", {**s, "hook_event_name": "SubagentStop", "agent_id": "a1", "agent_type": "tester",
                    "last_assistant_message": "3 tests added"})
    hook("claude", {**s, "hook_event_name": "PostToolUse", "tool_name": "Task", "tool_use_id": "u1", "tool_response": {}})
    hook("claude", {**s, "hook_event_name": "Stop", "stop_hook_active": False, "last_assistant_message": "Done"})
    a = agents("claude-code:k1")
    assert a["a1"]["input"] == "write pytest cases" and a["a1"]["current_task"] == "write tests", a["a1"]
    assert a["a1"]["tool_calls"] == 1 and a["main"]["tool_calls"] == 1 and a["main"]["status"] == "completed"

    # Cursor also executes ~/.claude hooks: those must be ignored to avoid double counting
    hook("claude", {"session_id": "dup", "hook_event_name": "SessionStart", "cursor_version": "2.0"})
    assert all(r["run_id"] != "claude-code:dup" for r in get("/api/runs"))

    x = {"session_id": "x1", "turn_id": "t1", "cwd": "/w/cli", "model": "gpt-5"}
    hook("codex", {**x, "hook_event_name": "UserPromptSubmit", "prompt": "build"})
    hook("codex", {**x, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_use_id": "b1", "tool_input": {"command": "make"}})
    hook("codex", {**x, "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_use_id": "b1",
                   "tool_response": {"exit_code": 2, "stderr": "no rule"}})
    hook("codex", {**x, "hook_event_name": "Stop", "stop_hook_active": False, "last_assistant_message": "make failed"})
    assert get("/api/runs/codex:x1")["metrics"]["errors"] == 1


def test_reducer_regressions() -> None:
    c = {"conversation_id": "c2", "generation_id": "g2"}
    hook("cursor", {**c, "hook_event_name": "beforeSubmitPrompt", "prompt": "x"})
    hook("cursor", {**c, "hook_event_name": "subagentStart", "subagent_id": "f1", "subagent_type": "shell", "task": "boom"})
    hook("cursor", {**c, "hook_event_name": "subagentStop", "subagent_type": "other", "status": "error", "task": "nope"})
    f1 = agents("cursor:c2")["f1"]
    assert f1["ended_at"] is None and f1["status"] == "planning", f1  # unmatched stop is dropped, not pinned on f1
    hook("cursor", {**c, "hook_event_name": "subagentStop", "subagent_type": "shell", "status": "error", "task": "boom"})
    run = get("/api/runs/cursor:c2")
    assert run["metrics"]["errors"] == 1, run["metrics"]  # task_failed + agent_end(failed) count once
    assert {a["id"]: a for a in run["agents"]}["main"]["status"] == "running"  # parent released from waiting

    s = {"session_id": "k2"}
    hook("claude", {**s, "hook_event_name": "Notification", "message": "needs permission"})
    assert agents("claude-code:k2")["main"]["status"] == "waiting"
    hook("claude", {**s, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_use_id": "p1", "tool_input": {}})
    assert agents("claude-code:k2")["main"]["status"] == "running"  # approval granted, work resumed


def test_sdk_scenarios() -> None:
    out = subprocess.run([sys.executable, str(ROOT / "examples" / "multi_agent_demo.py")], capture_output=True,
                         text=True, env={**os.environ, "OBSERVATORY_URL": BASE, "OPENAI_API_KEY": ""}, timeout=60)
    assert out.returncode == 0, out.stderr
    time.sleep(0.5)
    sdk_runs = [r for r in get("/api/runs") if r["platform"] == "sdk"]
    assert sum(r["title"] == "Case 2: sequential agents" for r in sdk_runs) == 2  # alone + concurrently in case 8
    runs = {r["title"]: r for r in sdk_runs}
    parallel = get(f"/api/runs/{runs['Case 3: parallel agents']['run_id']}")
    researchers = [a for a in parallel["agents"] if a["id"].startswith("researcher-")]
    assert len(researchers) >= 5 and all(a["parent"] == "planner" and a["status"] == "completed" for a in researchers)
    assert runs["Case 5: agent failure"]["status"] == "failed"
    assert runs["Case 5: agent failure"]["metrics"]["failed_tasks"] == 1
    assert runs["Case 6: tool failure"]["metrics"]["errors"] == 1
    assert runs["Case 6: tool failure"]["status"] == "completed"
    llm = runs["Case 7: LLM request failure"]["metrics"]
    assert llm["llm_calls"] == 1 and llm["errors"] == 2 and llm["total_tokens"] is None, llm


def test_cursor_windows_encoding_recovery() -> None:
    if os.name != "nt":
        return
    sys.path.insert(0, str(HOOK.parent))
    from observe_hook import recover_cursor_windows_payload

    payload = {"hook_event_name": "preToolUse", "conversation_id": "enc", "tool_use_id": "e1",
               "tool_input": {"command": 'echo "中文测试 — 汇报"'}}
    original = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    tmp = Path(tempfile.gettempdir()) / "cursor-hook-payload-0-0-observatory-test.json"
    tmp.write_bytes(original)
    try:  # what Windows PowerShell 5.1 Get-Content (GBK) + UTF-8 $OutputEncoding hands the hook
        mangled = b"\xef\xbb\xbf" + original.decode("gbk", "replace").replace("\ufffd", "?").encode("utf-8") + b"\r\n"
        assert recover_cursor_windows_payload(mangled) == original
        assert recover_cursor_windows_payload(b'{"a": 1}') == b'{"a": 1}'
    finally:
        tmp.unlink()


def test_validation_and_websocket() -> None:
    assert post("/api/events", {"event_type": "bogus", "run_id": "r"}) == 422
    assert post("/api/events", {"event_type": "agent_start"}) == 422  # run_id required
    assert post("/api/hooks/unknown-tool", {}) == 400

    async def listen() -> dict[str, Any]:
        async with websockets.connect(f"ws://127.0.0.1:{PORT}/ws") as ws:
            hello = json.loads(await ws.recv())
            assert hello["type"] == "hello" and hello["runs"]
            async with websockets.connect(f"ws://127.0.0.1:{PORT}/ws"):  # second client, closed abruptly
                pass
            await asyncio.to_thread(post, "/api/events", {"event_type": "agent_start", "run_id": "ws", "source": "w"})
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), 5))
                if msg["type"] == "event":
                    return msg

    msg = asyncio.run(listen())
    assert msg["event"]["run_id"] == "ws" and msg["run"]["agents"][0]["id"] == "w"


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        server = uvicorn.Server(uvicorn.Config(create_app(Path(tmp) / "t.db", report_interval_min=0),
                                               host="127.0.0.1", port=PORT, log_level="warning"))
        threading.Thread(target=server.run, daemon=True).start()
        while not server.started:
            time.sleep(0.05)
        for name, fn in list(globals().items()):
            if name.startswith("test_"):
                fn()
                print(f"ok  {name}")
        server.should_exit = True
    print("all checks passed")
