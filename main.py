"""Agent Observatory entry point.

    python main.py            start the server + dashboard (http://127.0.0.1:7777)
    python main.py report     print a progress digest of the last hour
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOST = os.environ.get("OBSERVATORY_HOST", "127.0.0.1")
PORT = int(os.environ.get("OBSERVATORY_PORT", "7777"))
URL = f"http://{HOST}:{PORT}"


def ensure_dashboard_built() -> Path:
    dist = ROOT / "frontend" / "dist"
    if (dist / "index.html").exists():
        return dist
    npm = shutil.which("npm")
    if npm is None:
        logging.warning("frontend/dist missing and npm not found: API runs, dashboard unavailable")
        return dist
    logging.info("building dashboard (first run)...")
    frontend = ROOT / "frontend"
    if not (frontend / "node_modules").exists():
        subprocess.run([npm, "install"], cwd=frontend, check=True)
    subprocess.run([npm, "run", "build"], cwd=frontend, check=True)
    return dist


def serve() -> None:
    import uvicorn

    from observatory.server import create_app

    app = create_app(
        db_path=Path(os.environ.get("OBSERVATORY_DB", ROOT / "data" / "observatory.db")),
        report_interval_min=float(os.environ.get("OBSERVATORY_REPORT_INTERVAL_MIN", "30")),
        public_url=URL,
        static_dir=ensure_dashboard_built(),
    )
    logging.info("dashboard: %s", URL)
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")


def report() -> None:
    req = urllib.request.Request(f"{URL}/api/reports/now", method="POST")
    with urllib.request.urlopen(req, timeout=5) as resp:
        r = json.load(resp)
    print(r["title"], "\n" + r["body"], *r.get("lines", []), sep="\n")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    {"report": report}.get(sys.argv[1] if len(sys.argv) > 1 else "", serve)()
