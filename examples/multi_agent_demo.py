"""A small real multi-agent workflow instrumented with the Observatory SDK.

Agents do real work on a local directory (list files, read them, count lines/TODOs, review). If
OPENAI_API_KEY is set, the reviewer also calls a real OpenAI-compatible chat endpoint (tokens reported);
otherwise no LLM events are emitted except in the LLM-failure scenario.

    python examples/multi_agent_demo.py            # all scenarios
    python examples/multi_agent_demo.py 3 7        # only scenarios 3 and 7
"""

from __future__ import annotations

import json
import os
import sys
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from observatory.sdk import Tracer  # noqa: E402

TARGET = Path(os.environ.get("DEMO_TARGET", Path(__file__).resolve().parents[1] / "observatory"))
LLM_BASE = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
LLM_MODEL = os.environ.get("DEMO_MODEL", "gpt-4o-mini")


def chat(tr: Tracer, agent: str, prompt: str, base: str = LLM_BASE, key: str | None = None) -> str:
    with tr.llm(agent, LLM_MODEL, input=prompt) as call:
        req = urllib.request.Request(
            f"{base}/chat/completions",
            data=json.dumps({"model": LLM_MODEL, "messages": [{"role": "user", "content": prompt}]}).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {key or os.environ.get('OPENAI_API_KEY', '')}"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.load(resp)
        usage = body.get("usage") or {}
        call.output = body["choices"][0]["message"]["content"]
        call.input_tokens, call.output_tokens = usage.get("prompt_tokens"), usage.get("completion_tokens")
        call.total_tokens = usage.get("total_tokens")
        return str(call.output)


def list_files(tr: Tracer, agent: str) -> list[Path]:
    with tr.tool(agent, "list_files", {"dir": str(TARGET)}) as call:
        files = sorted(TARGET.glob("*.py"))
        call.output = [f.name for f in files]
    return files


def analyze(tr: Tracer, agent: str, path: Path) -> dict[str, int | str]:
    with tr.tool(agent, "read_file", {"path": str(path)}) as call:
        text = path.read_text(encoding="utf-8")
        call.output = f"{len(text)} chars"
    with tr.tool(agent, "count_metrics", {"path": path.name}) as call:
        result: dict[str, int | str] = {"file": path.name, "lines": text.count("\n"), "todos": text.count("ponytail:"),
                                        "defs": text.count("def ")}
        call.output = result
    return result


def researcher(tr: Tracer, parent: str, path: Path, idx: int) -> dict[str, int | str]:
    name = f"researcher-{idx}"
    tr.message(parent, name, f"analyze {path.name}")
    with tr.agent(name, parent=parent, input=path.name) as me, tr.task(me, f"analyze {path.name}"):
        result = analyze(tr, me, path)
        tr.message(me, parent, result)
        return result


def reviewer(tr: Tracer, parent: str, findings: list[dict[str, int | str]]) -> str:
    tr.message(parent, "reviewer", findings)
    with tr.agent("reviewer", parent=parent, input=findings) as me, tr.task(me, "review findings"):
        total = sum(int(f["lines"]) for f in findings)
        verdict = f"{len(findings)} files, {total} lines, largest: {max(findings, key=lambda f: int(f['lines']))['file']}"
        if os.environ.get("OPENAI_API_KEY"):
            verdict = chat(tr, me, f"In one sentence, review this code-size summary: {verdict}")
        tr.message(me, parent, verdict)
        return verdict


# -- scenarios -----------------------------------------------------------------------------------
def s1_single() -> None:
    tr = Tracer("Case 1: single agent")
    with tr.agent("analyst") as a, tr.task(a, "measure one file"):
        analyze(tr, a, list_files(tr, a)[0])
    tr.end()


def s2_sequential() -> None:
    tr = Tracer("Case 2: sequential agents")
    with tr.agent("planner") as p, tr.task(p, "sequential review"):
        files = list_files(tr, p)[:3]
        findings = [researcher(tr, p, f, i) for i, f in enumerate(files, 1)]
        reviewer(tr, p, findings)
    tr.end()


def s3_parallel() -> None:
    tr = Tracer("Case 3: parallel agents")
    with tr.agent("planner") as p, tr.task(p, "parallel review"):
        files = list_files(tr, p)
        with ThreadPoolExecutor(max_workers=4) as pool:
            findings = list(pool.map(lambda args: researcher(tr, p, *args), [(f, i) for i, f in enumerate(files, 1)]))
        reviewer(tr, p, findings)
    tr.end()


def s4_tool_roundtrip() -> None:
    tr = Tracer("Case 4: agent -> tool -> agent")
    with tr.agent("planner") as p, tr.task(p, "delegate via tool result"):
        files = list_files(tr, p)
        researcher(tr, p, files[-1], 1)
    tr.end()


def s5_agent_failure() -> None:
    tr = Tracer("Case 5: agent failure")
    try:
        with tr.agent("config-loader") as a, tr.task(a, "load workflow config"):
            Path(TARGET / "missing-workflow.yaml").read_text(encoding="utf-8")  # genuinely absent
    except FileNotFoundError as exc:
        tr.end("failed", str(exc))


def s6_tool_failure() -> None:
    tr = Tracer("Case 6: tool failure")
    with tr.agent("fetcher") as a, tr.task(a, "fetch remote spec, fall back to local"):
        try:
            with tr.tool(a, "http_get", {"url": "http://127.0.0.1:9/spec.json"}):
                urllib.request.urlopen("http://127.0.0.1:9/spec.json", timeout=2)  # discard port: refused
        except OSError:
            analyze(tr, a, list_files(tr, a)[0])
    tr.end()


def s7_llm_failure() -> None:
    tr = Tracer("Case 7: LLM request failure")
    with tr.agent("writer") as a, tr.task(a, "draft summary with LLM"):
        try:
            chat(tr, a, "Summarize the project", base="http://127.0.0.1:9/v1", key="unused")  # unreachable endpoint
        except OSError as exc:
            tr.error(a, f"LLM unavailable, degraded to local summary: {exc}")
    tr.end()


def s8_concurrent_runs() -> None:
    threads = [threading.Thread(target=f) for f in (s2_sequential, s3_parallel, s4_tool_roundtrip)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


SCENARIOS = {"1": s1_single, "2": s2_sequential, "3": s3_parallel, "4": s4_tool_roundtrip,
             "5": s5_agent_failure, "6": s6_tool_failure, "7": s7_llm_failure, "8": s8_concurrent_runs}

if __name__ == "__main__":
    for key in sys.argv[1:] or list(SCENARIOS):
        print(f"scenario {key}: {SCENARIOS[key].__name__}")
        SCENARIOS[key]()
