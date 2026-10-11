#!/usr/bin/env python3
"""Recover Colab artifacts announced on stdout into the local artifact store.

scripts/colab-run.sh pipes `colab exec` output through a tee'd log. Every
artifact is announced as an `ARTIFACT` JSON line that either carries the
payload inline (text artifacts: metrics, labels, summaries) or references a
remote path (binary artifacts: model adapters). This script replays those
announcements into benchmarks/results/colab/<run_id>/, verifying bytes and
SHA-256 digests and ensuring atomic scoped writes.

  python3 scripts/recover_colab_artifacts.py [options] <session> <log> <results_dir>

Inline payloads are verified and written atomically. Remote paths are fetched
with `colab download -s <session>` when the session is still alive.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ARTIFACT_RE = re.compile(r'^\s*\{"event":\s*"ARTIFACT".*$', re.IGNORECASE)
RECORD_RE = re.compile(r'^\s*\{"event":\s*"RECORD".*$', re.IGNORECASE)


def parse_event(line: str) -> dict | None:
    line = line.strip()
    if not line.startswith('{"event":'):
        return None
    try:
        data = json.loads(line)
        return data if isinstance(data, dict) else None
    except ValueError:
        return None


def safe_dest_path(results_dir: Path, run_id: str, name: str) -> Path:
    """Validate run_id and name to prevent directory traversal and path escape."""
    if not run_id or "/" in run_id or "\\" in run_id or ".." in run_id:
        raise ValueError(f"Path escape detected: insecure runId {run_id!r}")
    if not name or ".." in name or name.startswith("/") or name.startswith("\\"):
        raise ValueError(f"Path escape detected: insecure artifact name {name!r}")
    dest_dir = (results_dir / run_id).resolve()
    target = (dest_dir / name).resolve()
    if not target.is_relative_to(dest_dir):
        raise ValueError(f"Path escape detected: {name!r} escapes {dest_dir}")
    return target


def atomic_write(path: Path, data: bytes) -> None:
    """Write data to path atomically using a temporary file and rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def encode_payload(payload) -> bytes:
    """Encode payload matching scripts/lib/colab_persist.py format."""
    if isinstance(payload, bytes):
        return payload
    if isinstance(payload, str):
        return payload.encode("utf-8")
    return (json.dumps(payload, indent=2, ensure_ascii=False, default=str) + "\n").encode("utf-8")


def verify_payload(data: bytes, expected_sha: str | None, expected_bytes: int | None, name: str) -> None:
    """Verify byte size and SHA-256 digest against announced metadata."""
    if expected_bytes is not None and len(data) != expected_bytes:
        raise ValueError(f"Byte length mismatch for {name}: expected {expected_bytes}, got {len(data)}")
    if expected_sha is not None:
        actual_sha = hashlib.sha256(data).hexdigest()
        if actual_sha != expected_sha:
            raise ValueError(f"Checksum mismatch for {name}: expected {expected_sha}, got {actual_sha}")


def download(session: str, remote: str, local_tmp: Path) -> bool:
    local_tmp.parent.mkdir(parents=True, exist_ok=True)
    if local_tmp.exists():
        try:
            local_tmp.unlink()
        except OSError:
            pass
    try:
        res = subprocess.run(
            ["colab", "download", "-s", session, remote, str(local_tmp)],
            capture_output=True, text=True, timeout=600,
        )
        return res.returncode == 0 and local_tmp.exists()
    except Exception:
        return False


def recover_artifacts(
    session: str,
    log_path: str,
    results_dir: str,
    target_run_id: str | None = None,
    strict: bool = False,
) -> tuple[int, list, list, list]:
    results = Path(results_dir)
    results.mkdir(parents=True, exist_ok=True)
    recovered = []
    missing = []
    errors = []

    seen = {}
    records_by_key = {}

    log_file = Path(log_path)
    if not log_file.exists():
        print(f"ERROR: log file does not exist: {log_path}", file=sys.stderr)
        return 1, [], [], [f"log not found: {log_path}"]

    for raw in log_file.read_text(encoding="utf-8").splitlines():
        ev = parse_event(raw)
        if not ev:
            continue
        event_type = ev.get("event")
        if event_type == "ARTIFACT":
            name = ev.get("name")
            run_id = ev.get("runId", "unknown")
            if not name:
                continue
            if target_run_id and run_id != target_run_id:
                continue
            # Scoped by (run_id, name) so cross-run artifacts never collide
            seen[(run_id, name)] = ev
        elif event_type == "RECORD":
            name = ev.get("name")
            run_id = ev.get("runId", "unknown")
            record = ev.get("record")
            if name and record is not None:
                records_by_key.setdefault((run_id, name), []).append(record)

    for (run_id, name), artifact in seen.items():
        try:
            local = safe_dest_path(results, run_id, name)
        except ValueError as err:
            errors.append(str(err))
            print(f"  [security]  {err}", file=sys.stderr)
            continue

        # If local already exists on disk and passes verification, keep it as verified
        if local.exists() and "inline" not in artifact:
            data = local.read_bytes()
            try:
                verify_payload(data, artifact.get("sha256"), artifact.get("bytes"), name)
                recovered.append((name, len(data), "cached", run_id))
                continue
            except ValueError:
                pass

        if "inline" in artifact:
            payload = artifact["inline"]
            data = encode_payload(payload)
            try:
                verify_payload(data, artifact.get("sha256"), artifact.get("bytes"), name)
            except ValueError as err:
                errors.append(str(err))
                print(f"  [checksum]  {err}", file=sys.stderr)
                continue

            atomic_write(local, data)
            recovered.append((name, len(data), "inline", run_id))
        else:
            remote_path = artifact.get("path", "")
            tmp_download = local.with_name(f"{local.name}.{os.getpid()}.download.tmp")
            downloaded = download(session, remote_path, tmp_download) if remote_path else False

            if downloaded:
                data = tmp_download.read_bytes()
                try:
                    verify_payload(data, artifact.get("sha256"), artifact.get("bytes"), name)
                    os.replace(tmp_download, local)
                    recovered.append((name, len(data), "downloaded", run_id))
                except ValueError as err:
                    if tmp_download.exists():
                        tmp_download.unlink()
                    errors.append(str(err))
                    print(f"  [checksum]  {err}", file=sys.stderr)
            elif (run_id, name) in records_by_key and not local.exists():
                reconstructed = "".join(
                    json.dumps(r, ensure_ascii=False, default=str) + "\n"
                    for r in records_by_key[(run_id, name)]
                ).encode("utf-8")
                expected_bytes = artifact.get("bytes")
                if expected_bytes is None or len(reconstructed) == expected_bytes:
                    atomic_write(local, reconstructed)
                    recovered.append((name, len(reconstructed), "reconstructed", run_id))
                else:
                    missing.append((name, run_id, artifact.get("kind", "unknown")))
            else:
                missing.append((name, run_id, artifact.get("kind", "unknown")))

    print(f"recovered {len(recovered)} artifacts into {results}")
    for name, size, how, r_id in recovered:
        print(f"  [{how:>13}] {size:>8}  {r_id}/{name}")
    if missing:
        print(f"  [missing]       {len(missing)} remote artifact(s) (session released or not kept):")
        for name, r_id, kind in missing:
            print(f"                   {r_id}/{name} ({kind})")
    if errors:
        print(f"  [errors]        {len(errors)} error(s) during recovery:", file=sys.stderr)
        for err in errors:
            print(f"                   {err}", file=sys.stderr)

    if errors:
        return 1, recovered, missing, errors
    if strict and missing:
        return 1, recovered, missing, errors
    return 0, recovered, missing, errors


def main():
    parser = argparse.ArgumentParser(description="Recover Colab artifacts announced on stdout into the local artifact store.")
    parser.add_argument("--run-id", dest="run_id", default=None, help="Scope recovery to a specific run ID")
    parser.add_argument("--strict", action="store_true", help="Fail if any remote artifact could not be downloaded")
    parser.add_argument("session", help="Colab session name")
    parser.add_argument("log_path", help="Path to tee'd session log")
    parser.add_argument("results_dir", help="Destination results directory")

    args = parser.parse_args()
    code, _, _, _ = recover_artifacts(
        session=args.session,
        log_path=args.log_path,
        results_dir=args.results_dir,
        target_run_id=args.run_id,
        strict=args.strict,
    )
    return code


if __name__ == "__main__":
    sys.exit(main())