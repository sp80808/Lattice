#!/usr/bin/env python3
"""Recover Colab artifacts announced on stdout into the local artifact store.

scripts/colab-run.sh pipes `colab exec` output through a tee'd log. Every
artifact is announced as an `ARTIFACT` JSON line that either carries the
payload inline (text artifacts: metrics, labels, summaries) or references a
remote path (binary artifacts: model adapters). This script replays those
announcements into benchmarks/results/colab/<run_id>/, so a released VM loses
nothing that was flushed before it died.

  python3 scripts/recover_colab_artifacts.py <session> <log> <results_dir>

Inline payloads are written verbatim. Remote paths are fetched with
`colab download -s <session>` when the session is still alive.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ARTIFACT_RE = re.compile(r'^\s*\{"event":\s*"ARTIFACT".*$', re.IGNORECASE)


def parse_artifact(line):
    line = line.strip()
    if not line.startswith('{"event":'):
        return None
    try:
        return json.loads(line)
    except ValueError:
        return None


def download(session, remote, local):
    local = Path(local)
    local.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["colab", "download", "-s", session, remote, str(local)],
        capture_output=True, text=True, timeout=600,
    )
    return local.exists()


def main():
    session, log_path, results_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    results = Path(results_dir)
    results.mkdir(parents=True, exist_ok=True)
    recovered, missing = [], []
    seen = {}
    for raw in Path(log_path).read_text(encoding="utf-8").splitlines():
        artifact = parse_artifact(raw)
        if not artifact or artifact.get("event") != "ARTIFACT":
            continue
        name = artifact.get("name")
        if not name:
            continue
        # last announcement wins: a re-emitted artifact supersedes an earlier one
        seen[name] = artifact

    for name, artifact in seen.items():
        run_id = artifact.get("runId", "unknown")
        dest_dir = results / run_id
        dest_dir.mkdir(parents=True, exist_ok=True)
        local = dest_dir / name
        if "inline" in artifact:
            payload = artifact["inline"]
            data = payload.encode("utf-8") if isinstance(payload, str) else json.dumps(payload, indent=2, ensure_ascii=False, default=str).encode()
            local.write_bytes(data)
            recovered.append((name, len(data), "inline"))
        elif download(session, artifact.get("path", ""), local):
            recovered.append((name, local.stat().st_size, "downloaded"))
        else:
            missing.append(name)

    print(f"recovered {len(recovered)} artifacts into {results}")
    for name, size, how in recovered:
        print(f"  [{how:>10}] {size:>8}  {name}")
    if missing:
        print(f"  [missing]   {len(missing)} remote artifacts (session released or not kept):")
        for name in missing:
            print(f"               {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())