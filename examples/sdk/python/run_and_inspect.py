#!/usr/bin/env python3
"""Drive the Lattice daemon from Python with lattice_sdk (standard library only).

    npm run build && python3 examples/sdk/python/run_and_inspect.py

Uses $LATTICE_URL if a daemon is already running (`lattice serve`); otherwise
starts `lattice serve --port 0` against a temporary copy of the demo project.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "sdks" / "python" / "src"))

from lattice_sdk import LatticeApiError, LatticeClient  # noqa: E402


def start_daemon(project: str) -> tuple[subprocess.Popen, str]:
    cli = REPO / "apps" / "cli" / "dist" / "index.js"
    process = subprocess.Popen(
        ["node", str(cli), "serve", "--port", "0", "-C", project],
        stdout=subprocess.PIPE,
        text=True,
    )
    line = process.stdout.readline()
    match = re.search(r"http://127\.0\.0\.1:\d+", line)
    if not match:
        process.kill()
        raise RuntimeError(f"daemon did not start: {line!r}")
    return process, match.group(0)


def main() -> int:
    project = tempfile.mkdtemp(prefix="lattice-sdk-py-")
    shutil.copytree(REPO / "examples" / "demo-repo", project, dirs_exist_ok=True)
    # Observe-mode config: every run also executes the project's test suite as evidence.
    (Path(project) / ".lattice").mkdir()
    (Path(project) / ".lattice" / "config.json").write_text(
        json.dumps({"mode": "observe", "verify": {"command": "npm", "args": ["test"], "timeoutMs": 60000}})
    )

    daemon = None
    base_url = os.environ.get("LATTICE_URL")
    if not base_url:
        daemon, base_url = start_daemon(project)
        print(f"started daemon at {base_url}")

    try:
        client = LatticeClient(base_url)
        health = client.wait_until_ready()
        print(f"daemon: {health['service']} {health['version']}")

        run = client.run_task("why does the add test fail?", cwd=project, mode="observe")
        print(f"\nrun {run['runId']} ({run['runtimeMode']}): {run['summary']}")

        for summary in client.list_runs(cwd=project, limit=5):
            print(f"  {summary['runId'][:8]}  {summary['status']}  {summary['task']}")

        detail = client.get_run("latest", cwd=project)
        print("\nTAP evidence:")
        for item in detail["tap"]["evidence"]:
            print(f"  {item['kind']}: {' '.join(item['summary'].split())[:80]}")

        events = client.get_events(detail["runId"], cwd=project)
        print("\nevent types:", ", ".join(event["type"] for event in events))

        decision = client.decide(
            "Which experiment is the cheapest discriminating next step?",
            [
                {"id": "run-tests", "label": "Run the failing test in isolation"},
                {"id": "read-src", "label": "Read src/calc.js"},
            ],
            provider="random",
            cwd=project,
        )
        print(f"\ndecision ({decision['identity']['provider']}): {', '.join(decision['selected'])}")

        try:
            client.get_run("deadbeef", cwd=project)
        except LatticeApiError as error:
            print(f"\nexpected error: {error.status} {error.code} — {error}")
    finally:
        if daemon:
            daemon.terminate()
            daemon.wait(timeout=10)
            daemon.stdout.close()
        shutil.rmtree(project, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
