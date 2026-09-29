"""Unified event schema shared by every producer (Cursor / Claude Code / Codex hooks, Python SDK).

The frontend mirrors this in `frontend/src/types.ts`; `GET /api/schema` serves the JSON Schema.
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

EventType = Literal[
    "run_start",
    "run_end",
    "agent_start",
    "agent_end",
    "agent_status",
    "task_create",
    "task_start",
    "task_complete",
    "task_failed",
    "agent_message",
    "llm_start",
    "llm_end",
    "tool_start",
    "tool_end",
    "error",
]

Status = Literal["idle", "planning", "running", "waiting", "completed", "failed", "aborted"]

USER = "user"
MAIN = "main"
MAX_TEXT = 8000


def _clip(value: Any) -> Any:
    """Keep payloads bounded: huge file contents / tool outputs would bloat the store and WS frames."""
    if isinstance(value, str):
        return value if len(value) <= MAX_TEXT else value[:MAX_TEXT] + f"... [+{len(value) - MAX_TEXT} chars]"
    if isinstance(value, dict):
        return {k: _clip(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_clip(v) for v in value[:200]]
    return value


class Event(BaseModel):
    event_id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    timestamp: float = Field(default_factory=lambda: time.time() * 1000, description="epoch milliseconds")
    event_type: EventType
    platform: str = "sdk"
    run_id: str = Field(min_length=1, max_length=200)
    task_id: str | None = None
    source: str | None = Field(default=None, description="agent id that produced the event")
    target: str | None = Field(default=None, description="receiving agent id (messages)")
    status: Status | None = None
    data: dict[str, Any] = Field(default_factory=dict)
    duration_ms: float | None = None

    @field_validator("data")
    @classmethod
    def _bound_data(cls, v: dict[str, Any]) -> dict[str, Any]:
        return _clip(v)
