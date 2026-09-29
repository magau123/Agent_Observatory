"""WebSocket fan-out. A slow or broken client is dropped; it can never block or crash ingestion."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import WebSocket

log = logging.getLogger("observatory.hub")
SEND_TIMEOUT_S = 2.0


class Hub:
    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()

    async def connect(self, ws: WebSocket, hello: dict[str, Any]) -> None:
        await ws.accept()
        await ws.send_text(json.dumps(hello, ensure_ascii=False, default=str))
        self.clients.add(ws)
        log.info("client connected (%d total)", len(self.clients))

    def disconnect(self, ws: WebSocket) -> None:
        if ws in self.clients:
            self.clients.discard(ws)
            log.info("client disconnected (%d total)", len(self.clients))

    async def broadcast(self, message: dict[str, Any]) -> None:
        if not self.clients:
            return
        text = json.dumps(message, ensure_ascii=False, default=str)

        async def send(ws: WebSocket) -> None:
            try:
                await asyncio.wait_for(ws.send_text(text), SEND_TIMEOUT_S)
            except Exception as exc:  # noqa: BLE001 - any client failure just drops that client
                log.warning("dropping websocket client: %r", exc)
                self.disconnect(ws)

        await asyncio.gather(*(send(ws) for ws in list(self.clients)))
