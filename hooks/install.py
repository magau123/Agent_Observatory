#!/usr/bin/env python3
"""Install / uninstall Agent Observatory hooks into user-level configs.

    python hooks/install.py                    # every detected tool (~/.cursor, ~/.claude, ~/.codex)
    python hooks/install.py cursor codex       # only these
    python hooks/install.py --uninstall        # remove our entries, keep everything else

Idempotent: existing Observatory entries are replaced, other hooks are left untouched.
A one-time `.bak` copy is written before a config file is first modified.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path
from typing import Any

HOME = Path.home()
SCRIPT = Path(__file__).resolve().with_name("observe_hook.py")
MARKER = "observe_hook.py"

CURSOR_EVENTS = ["sessionStart", "sessionEnd", "beforeSubmitPrompt", "preToolUse", "postToolUse",
                 "postToolUseFailure", "subagentStart", "subagentStop", "afterAgentResponse",
                 "afterAgentThought", "stop"]
CLAUDE_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse",
                 "PostToolUseFailure", "Notification", "SubagentStart", "SubagentStop", "Stop"]
CODEX_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse",
                "PermissionRequest", "SubagentStart", "SubagentStop", "Stop"]


def command(platform: str) -> str:
    # Forward slashes work in cmd, PowerShell and Git Bash alike; quote only when a path has spaces.
    parts = [Path(sys.executable).as_posix(), SCRIPT.as_posix(), platform]
    return " ".join(f'"{p}"' if " " in p else p for p in parts)


def load(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8").strip()
    return json.loads(text) if text else {}


def save(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    backup = path.with_suffix(path.suffix + ".bak")
    if path.exists() and not backup.exists():
        shutil.copy2(path, backup)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def ours(entry: dict[str, Any]) -> bool:
    return MARKER in json.dumps(entry)


def install_cursor(uninstall: bool) -> Path:
    path = HOME / ".cursor" / "hooks.json"
    cfg = load(path)
    cfg.setdefault("version", 1)
    hooks: dict[str, list[dict[str, Any]]] = cfg.setdefault("hooks", {})
    for event in CURSOR_EVENTS:
        kept = [h for h in hooks.get(event, []) if not ours(h)]
        if not uninstall:
            kept.append({"command": command("cursor"), "timeout": 5})
        hooks[event] = kept
        if not kept:
            hooks.pop(event)
    save(path, cfg)
    return path


def _install_nested(path: Path, events: list[str], platform: str, uninstall: bool) -> None:
    """Claude Code and Codex share the `{event: [{matcher?, hooks: [{type, command}]}]}` layout."""
    cfg = load(path)
    hooks: dict[str, list[dict[str, Any]]] = cfg.setdefault("hooks", {})
    for event in events:
        kept = [g for g in hooks.get(event, []) if not ours(g)]
        if not uninstall:
            kept.append({"hooks": [{"type": "command", "command": command(platform), "timeout": 5}]})
        hooks[event] = kept
        if not kept:
            hooks.pop(event)
    save(path, cfg)


def install_claude(uninstall: bool) -> Path:
    path = HOME / ".claude" / "settings.json"
    _install_nested(path, CLAUDE_EVENTS, "claude", uninstall)
    return path


def install_codex(uninstall: bool) -> Path:
    path = HOME / ".codex" / "hooks.json"
    _install_nested(path, CODEX_EVENTS, "codex", uninstall)
    if not uninstall:
        enable_codex_hooks_feature(HOME / ".codex" / "config.toml")
    return path


def enable_codex_hooks_feature(toml: Path) -> None:
    text = toml.read_text(encoding="utf-8") if toml.exists() else ""
    if re.search(r"(?m)^\s*hooks\s*=\s*true", text):
        return
    if re.search(r"(?m)^\[features\]\s*$", text):
        text = re.sub(r"(?m)^\[features\]\s*$", "[features]\nhooks = true", text, count=1)
    else:
        text = text.rstrip() + ("\n\n" if text.strip() else "") + "[features]\nhooks = true\n"
    toml.parent.mkdir(parents=True, exist_ok=True)
    toml.write_text(text, encoding="utf-8")


INSTALLERS = {"cursor": (install_cursor, ".cursor"), "claude": (install_claude, ".claude"),
              "codex": (install_codex, ".codex")}


def main(argv: list[str]) -> None:
    uninstall = "--uninstall" in argv
    wanted = [a for a in argv if not a.startswith("--")]
    unknown = set(wanted) - INSTALLERS.keys()
    if unknown:
        sys.exit(f"unknown tool(s): {', '.join(sorted(unknown))}; choose from {', '.join(INSTALLERS)}")
    targets = wanted or [k for k, (_, d) in INSTALLERS.items() if (HOME / d).is_dir()]
    if not targets:
        sys.exit("no Cursor / Claude Code / Codex config dir found; pass tool names explicitly")
    for name in targets:
        path = INSTALLERS[name][0](uninstall)
        print(f"{'removed from' if uninstall else 'installed into'} {name}: {path}")
    if "codex" in targets and not uninstall:
        print("codex: enabled [features].hooks in ~/.codex/config.toml; approve the hooks once via /hooks in Codex")


if __name__ == "__main__":
    main(sys.argv[1:])
