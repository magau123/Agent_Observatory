"""SQLite persistence for events and reports. State is rebuilt by replaying events at startup."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Iterator

from .schema import Event


class Store:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS events (
                event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, ts REAL NOT NULL, body TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS events_run ON events(run_id, ts);
            CREATE TABLE IF NOT EXISTS reports (
                id TEXT PRIMARY KEY, ts REAL NOT NULL, body TEXT NOT NULL);
            """
        )

    def add_event(self, ev: Event) -> None:
        self.db.execute("INSERT OR IGNORE INTO events VALUES (?,?,?,?)",
                        (ev.event_id, ev.run_id, ev.timestamp, ev.model_dump_json()))
        self.db.commit()

    def all_events(self) -> Iterator[Event]:
        # ponytail: full replay on boot; fine up to ~10^5 events, add snapshots/retention beyond that.
        for (body,) in self.db.execute("SELECT body FROM events ORDER BY ts, rowid"):
            yield Event.model_validate_json(body)

    def run_events(self, run_id: str, since: float = 0, until: float | None = None, limit: int = 5000) -> list[Event]:
        rows = self.db.execute(
            "SELECT body FROM (SELECT body, ts, rowid FROM events WHERE run_id=? AND ts>=? AND ts<=? "
            "ORDER BY ts DESC, rowid DESC LIMIT ?) ORDER BY ts, rowid",
            (run_id, since, until if until is not None else float("inf"), limit))
        return [Event.model_validate_json(b) for (b,) in rows]

    def delete_run(self, run_id: str) -> None:
        self.db.execute("DELETE FROM events WHERE run_id=?", (run_id,))
        self.db.commit()

    def add_report(self, report: dict[str, Any]) -> None:
        self.db.execute("INSERT OR REPLACE INTO reports VALUES (?,?,?)",
                        (report["id"], report["ts"], json.dumps(report, ensure_ascii=False)))
        self.db.commit()

    def reports(self, limit: int = 50) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT body FROM reports ORDER BY ts DESC LIMIT ?", (limit,))
        return [json.loads(b) for (b,) in rows]
