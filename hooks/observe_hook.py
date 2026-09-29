#!/usr/bin/env python3
"""Forward a coding-agent hook payload (stdin JSON) to Agent Observatory.

Usage: observe_hook.py <cursor|claude|codex>

Standard library only. Always exits 0 and prints `{}` so the agent is never blocked or altered,
whether or not the Observatory server is running.
"""

import codecs
import json
import os
import re
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


ID_FIELDS = ("hook_event_name", "conversation_id", "generation_id", "tool_use_id", "subagent_id")


def _ids(text: str) -> dict[str, str]:
    return {k: m.group(1) for k in ID_FIELDS if (m := re.search(rf'"{k}"\s*:\s*"([^"]*)"', text))}


def _ascii_len(text: str) -> int:
    return sum(ch.isascii() for ch in text)


def recover_cursor_windows_payload(raw: bytes) -> bytes:
    """Cursor on Windows runs `Get-Content <tmp>.json -Raw | <hook>` in Windows PowerShell 5.1, which decodes
    the UTF-8 temp file with the ANSI code page (e.g. GBK): non-ASCII text arrives mangled, partly replaced by
    '?', so it cannot be reversed. Instead find that temp file (ASCII id fields survive) and use its bytes."""
    body = raw[len(codecs.BOM_UTF8):] if raw.startswith(codecs.BOM_UTF8) else raw
    text = body.decode("utf-8", "replace")
    if os.name != "nt" or text.isascii():
        return body
    want = _ids(text)
    if "hook_event_name" not in want:
        return body
    cutoff = time.time() - 300
    best: tuple[int, bytes] | None = None
    for f in Path(tempfile.gettempdir()).glob("cursor-hook-payload-*.json"):
        try:
            if f.stat().st_mtime < cutoff:
                continue
            original = f.read_bytes()
        except OSError:
            continue
        candidate = original.decode("utf-8", "replace")
        if _ids(candidate) != want:
            continue
        distance = abs(_ascii_len(candidate) - _ascii_len(text))  # disambiguates same-id payloads (e.g. thoughts)
        if best is None or distance < best[0]:
            best = (distance, original)
    return best[1] if best else body


def main() -> None:
    platform = sys.argv[1] if len(sys.argv) > 1 else "cursor"
    raw = sys.stdin.buffer.read()
    if platform == "cursor":
        raw = recover_cursor_windows_payload(raw)
    data_dir = Path(__file__).resolve().parents[1] / "data"
    if (data_dir / "capture-hooks").exists():  # debug switch for adapting to hook format changes
        with open(data_dir / "raw_hooks.jsonl", "ab") as f:
            f.write(platform.encode() + b"\t" + raw.strip() + b"\n")
    if platform == "claude" and b"cursor_version" in raw:
        try:
            if "cursor_version" in json.loads(raw):
                return  # Cursor also runs ~/.claude hooks; its own cursor hook already reports this event
        except ValueError:
            return
    url = os.environ.get("OBSERVATORY_URL", "http://127.0.0.1:7777").rstrip("/") + f"/api/hooks/{platform}"
    req = urllib.request.Request(url, data=raw, headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=1.5).close()


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - observability must never break the observed agent
        pass
    sys.stdout.write("{}")
