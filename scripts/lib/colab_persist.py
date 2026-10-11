"""Milestone-durable run bookkeeping for Colab jobs.

Every Colab job must be an atomic, interrupt-tolerant unit, because Colab
sessions are pruned and VMs are released while work is in flight:

  * a run manifest is written to disk *before* any work starts, so a killed
    session is classified `interrupted` with a reason, never silently `lost`
  * every artifact is flushed atomically (tmp + rename) into
    /content/out/<run_id>/ and announced on stdout, so the local wrapper
    (scripts/colab-run.sh) recovers it even after the VM is released
  * `is_done()` makes `--resume` idempotent: completed steps are skipped and
    a re-launched job finishes only the remainder
  * Google Drive mirroring is best-effort: text artifacts survive via stdout,
    but binary artifacts (adapters) only survive if Drive is mounted

Stdout protocol — one JSON object per line; nothing else uses these keys:

    ARTIFACT {"event":"ARTIFACT","runId":...,"name":...,"kind":...,
              "bytes":...,"sha256":...,"path":...,"inline":<payload>}
    RECORD   {"event":"RECORD","name":...,"record":{...}}
    RUN      {"event":"RUN","runId":...,"outcome":"running|completed|interrupted",
              "reason":...}

`inline` carries the payload itself (capped by LATTICE_STREAM_LIMIT) so that a
tee'd stdout log alone is a complete, durable copy of every text artifact.
"""

import datetime as dt
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

OUT_ROOT = Path(os.environ.get("LATTICE_OUT_ROOT", "/content/out"))
DRIVE_DIR = os.environ.get("LATTICE_DRIVE_DIR", "/content/drive/MyDrive/lattice-runs")
STREAM_LIMIT = int(os.environ.get("LATTICE_STREAM_LIMIT", str(512 * 1024)))
DRIVE_ENABLED = os.environ.get("LATTICE_DRIVE", "1") == "1"


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_sha() -> str:
    """Harness revision for provenance; 'nogit' when run outside a checkout."""
    for candidate in (os.environ.get("LATTICE_REPO_DIR"), os.getcwd()):
        if not candidate:
            continue
        try:
            out = subprocess.run(
                ["git", "-C", candidate, "rev-parse", "--short", "HEAD"],
                capture_output=True, text=True, timeout=5,
            )
            if out.returncode == 0 and out.stdout.strip():
                return out.stdout.strip()
        except Exception:
            continue
    return "nogit"


def new_run_id(name: str) -> str:
    stamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    return f"{name}-{stamp}-{git_sha()}"


def _atomic_write(path, data: bytes) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _encode(payload) -> bytes:
    if isinstance(payload, bytes):
        return payload
    if isinstance(payload, str):
        return payload.encode("utf-8")
    return (json.dumps(payload, indent=2, ensure_ascii=False, default=str) + "\n").encode("utf-8")


class ColabRun:
    """One Colab job invocation. Safe to re-create across exec calls: an
    existing manifest for the same run id is resumed, never overwritten."""

    def __init__(self, name: str, out_root=None):
        self.name = name
        self.out_root = Path(out_root or OUT_ROOT)
        self.run_id = os.environ.get("LATTICE_RUN_ID") or new_run_id(name)
        os.environ["LATTICE_RUN_ID"] = self.run_id
        self.dir = self.out_root / self.run_id
        self.dir.mkdir(parents=True, exist_ok=True)
        self.manifest_path = self.dir / "manifest.json"
        if os.environ.get("LATTICE_PERSIST_DEBUG"):
            print(f"[persist-debug] init dir={self.dir} manifest_path={self.manifest_path} "
                  f"exists={self.manifest_path.exists()} out_root={self.out_root}", flush=True)
        self.manifest = self._load_or_init()

    # ------------------------------------------------------------- manifest

    def _load_or_init(self) -> dict:
        import os as _os
        if _os.environ.get("LATTICE_PERSIST_DEBUG"):
            print(f"[persist-debug] exists={self.manifest_path.exists()} path={self.manifest_path}", flush=True)
        if self.manifest_path.exists():
            try:
                manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
                manifest.setdefault("artifacts", [])
                manifest["resumed"] = int(manifest.get("resumed", 0)) + 1
                manifest["lastResumedAt"] = utcnow().isoformat()
                manifest["outcome"] = "running"
                self._save_manifest(manifest)
                print(json.dumps({
                    "event": "RUN", "runId": self.run_id, "outcome": "running",
                    "resumed": manifest["resumed"],
                    "reason": f"resumed; {len(manifest.get('artifacts', []))} artifacts already present",
                }, ensure_ascii=False), flush=True)
                return manifest
            except Exception:
                pass  # a corrupt manifest must never abort the job
        manifest = {
            "runId": self.run_id,
            "job": self.name,
            "outcome": "running",
            "startedAt": utcnow().isoformat(),
            "gitSha": git_sha(),
            "artifacts": [],
            "resumed": 0,
        }
        self._save_manifest(manifest)
        print(json.dumps({
            "event": "RUN", "runId": self.run_id, "outcome": "running",
            "reason": "manifest written before any work; a killed run is now classifiable",
        }, ensure_ascii=False), flush=True)
        return manifest

    def _save_manifest(self, manifest: dict) -> None:
        if os.environ.get("LATTICE_PERSIST_DEBUG"):
            import traceback as _tb
            print(f"[persist-debug] save_manifest artifacts={len(manifest.get('artifacts', []))} "
                  f"outcome={manifest.get('outcome')} path={self.manifest_path}", flush=True)
            print("".join(_tb.format_stack()[-4:-1]), flush=True)
        _atomic_write(
            self.manifest_path,
            (json.dumps(manifest, indent=2, ensure_ascii=False, default=str) + "\n").encode("utf-8"),
        )

    # ------------------------------------------------------------- artifacts

    def is_done(self, name: str) -> bool:
        return any(record["name"] == name for record in self.manifest["artifacts"])

    def done(self) -> set:
        return {record["name"] for record in self.manifest["artifacts"]}

    def path_for(self, name: str):
        return self.dir / name

    def _announce(self, record: dict, payload=None, stream: bool = True) -> None:
        line = {"event": "ARTIFACT", "runId": self.run_id, **record}
        if stream and payload is not None:
            try:
                encoded = _encode(payload)
                if len(encoded) <= STREAM_LIMIT:
                    line["inline"] = payload if isinstance(payload, (dict, list)) else encoded.decode("utf-8", "replace")
            except Exception:
                pass
        print(json.dumps(line, ensure_ascii=False, default=str), flush=True)

    def _mirror(self, name: str, path) -> None:
        if not DRIVE_ENABLED:
            return
        drive = Path(DRIVE_DIR)
        if not drive.exists():
            return
        try:
            dest = drive / self.run_id / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, dest)
        except Exception:
            pass  # Drive is an optimization; stdout is the durability guarantee

    def _register(self, record: dict) -> None:
        self.manifest["artifacts"].append(record)
        self._save_manifest(self.manifest)

    def emit(self, name: str, payload, kind: str = "metrics", stream: bool = True):
        """Atomically write one artifact and make its existence durable."""
        data = _encode(payload)
        path = self.path_for(name)
        _atomic_write(path, data)
        record = {
            "name": name, "kind": kind, "bytes": len(data),
            "sha256": sha256_bytes(data), "path": str(path),
            "at": utcnow().isoformat(),
        }
        self._register(record)
        self._mirror(name, path)
        self._announce(record, payload if isinstance(payload, (dict, list, str)) else None, stream)
        return path

    def append_jsonl(self, name: str, rows, stream: bool = True):
        """Append records with flush+fsync; each row is echoed to stdout so a
        tee'd log alone is a complete copy even if /content is lost."""
        path = self.path_for(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        fresh = not path.exists()
        with open(path, "a", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        record = {
            "name": name, "kind": "dataset", "appended": len(rows),
            "lines": sum(1 for _ in path.open(encoding="utf-8")),
            "bytes": path.stat().st_size, "path": str(path),
            "at": utcnow().isoformat(),
        }
        self._register(record)
        self._mirror(name, path)
        self._announce({k: v for k, v in record.items() if k != "at"}, stream=stream)
        if fresh and stream:
            # first append: replay nothing; rows below are the content
            pass
        if stream:
            for row in rows:
                print(json.dumps({"event": "RECORD", "name": name, "record": row},
                                 ensure_ascii=False, default=str), flush=True)
        return path

    def read_jsonl(self, name: str):
        path = self.path_for(name)
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    # ------------------------------------------------------------- outcome

    def complete(self, summary=None) -> None:
        self.manifest["outcome"] = "completed"
        self.manifest["completedAt"] = utcnow().isoformat()
        if summary is not None:
            self.manifest["summary"] = summary
        self._save_manifest(self.manifest)
        print(json.dumps({
            "event": "RUN", "runId": self.run_id, "outcome": "completed",
            "reason": "job finished; every artifact flushed", "summary": summary,
        }, ensure_ascii=False, default=str), flush=True)

    def interrupt(self, reason: str) -> None:
        """Called on fatal error: the run is classified, not lost."""
        self.manifest["outcome"] = "interrupted"
        self.manifest["interruptedAt"] = utcnow().isoformat()
        self.manifest["reason"] = reason
        self._save_manifest(self.manifest)
        print(json.dumps({
            "event": "RUN", "runId": self.run_id, "outcome": "interrupted", "reason": reason,
        }, ensure_ascii=False), flush=True)
