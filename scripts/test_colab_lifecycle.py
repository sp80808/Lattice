#!/usr/bin/env python3
"""Offline fake-CLI lifecycle and recovery tests for Lattice Colab automation.

Verifies the acceptance criteria from beads task lat-rbf and
docs/research/2026-10-11-colab-priority-review.md:
  1. session-list failure without launching
  2. job failure
  3. timeout/exhaustion
  4. stale completion markers
  5. recovery failure
  6. released VM with inline artifacts
  7. cross-run duplicate names
  8. path escape
  9. checksum mismatch
"""

import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

ROOT_DIR = Path(__file__).resolve().parents[1]
COLAB_RUN_SH = ROOT_DIR / "scripts" / "colab-run.sh"
RECOVER_PY = ROOT_DIR / "scripts" / "recover_colab_artifacts.py"


def sha256_text(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


class ColabLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.tmp = Path(self.temp_dir.name)
        self.bin_dir = self.tmp / "bin"
        self.bin_dir.mkdir(parents=True, exist_ok=True)
        self.fake_colab = self.bin_dir / "colab"
        self.state_file = self.tmp / "fake_colab_state.json"

        fake_script = f"""#!/usr/bin/env python3
import sys, os, json
state_file = "{self.state_file}"
state = {{}}
if os.path.exists(state_file):
    with open(state_file, "r") as f:
        state = json.load(f)

args = sys.argv[1:]
cmd = args[0] if args else "help"
recorded = state.setdefault("calls", [])
recorded.append(args)

with open(state_file, "w") as f:
    json.dump(state, f)

if cmd == "sessions":
    code = state.get("sessions_code", 0)
    out = state.get("sessions_out", "No active sessions found on server.\\n")
    sys.stdout.write(out)
    sys.exit(code)
elif cmd == "new":
    code = state.get("new_code", 0)
    sys.stdout.write("session created\\n")
    sys.exit(code)
elif cmd == "upload":
    sys.exit(state.get("upload_code", 0))
elif cmd == "exec":
    code = state.get("exec_code", 0)
    out = state.get("exec_out", "JOB_COMPLETE\\n")
    sys.stdout.write(out)
    sys.exit(code)
elif cmd == "download":
    code = state.get("download_code", 1)
    if code == 0 and len(args) >= 5:
        dest = args[4]
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(state.get("download_bytes", b"binary-data"))
    sys.exit(code)
elif cmd == "usage":
    sys.stdout.write("Current balance: 100.0 compute units\\n")
    sys.exit(0)
elif cmd == "stop":
    sys.exit(0)
sys.exit(0)
"""
        self.fake_colab.write_text(fake_script, encoding="utf-8")
        self.fake_colab.chmod(self.fake_colab.stat().st_mode | stat.S_IEXEC)

        self.env = dict(os.environ)
        self.env["PATH"] = f"{self.bin_dir}:{self.env['PATH']}"
        self.env["LATTICE_REPO_DIR"] = str(ROOT_DIR)

    def tearDown(self):
        self.temp_dir.cleanup()

    def set_state(self, **kwargs):
        state = {}
        if self.state_file.exists():
            state = json.loads(self.state_file.read_text())
        state.update(kwargs)
        self.state_file.write_text(json.dumps(state))

    def get_calls(self):
        if not self.state_file.exists():
            return []
        state = json.loads(self.state_file.read_text())
        return state.get("calls", [])

    # 1. session-list failure without launching
    def test_session_list_failure_exits_nonzero_without_calling_new(self):
        self.set_state(sessions_code=1, sessions_out="Error: network offline\n")
        res = subprocess.run(
            ["bash", str(COLAB_RUN_SH), "zero-shot", "--session", "s-test"],
            cwd=str(self.tmp),
            env=self.env,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("'colab sessions' failed", res.stderr)
        new_calls = [c for c in self.get_calls() if c and c[0] == "new"]
        self.assertEqual(len(new_calls), 0, "colab new must NOT be called when session listing fails")

    # 2. job failure
    def test_job_failure_exits_nonzero(self):
        self.set_state(
            sessions_code=0,
            sessions_out="[s-test] t4\n",
            exec_code=1,
            exec_out='{"event": "RUN", "runId": "run-fail", "outcome": "interrupted", "reason": "GPU OOM"}\nJOB_FAILED\n',
        )
        res = subprocess.run(
            ["bash", str(COLAB_RUN_SH), "zero-shot", "--session", "s-test", "--max-calls", "1"],
            cwd=str(self.tmp),
            env=self.env,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("job failed", res.stdout)

    # 3. timeout / call exhaustion
    def test_call_exhaustion_exits_nonzero(self):
        self.set_state(
            sessions_code=0,
            sessions_out="[s-test] t4\n",
            exec_code=0,
            exec_out="Working step 1...\n",
        )
        res = subprocess.run(
            ["bash", str(COLAB_RUN_SH), "zero-shot", "--session", "s-test", "--max-calls", "2"],
            cwd=str(self.tmp),
            env=self.env,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("job exhausted 2 calls", res.stdout)

    # 4. stale completion markers do not trigger false success
    def test_stale_completion_markers_ignored(self):
        logs_dir = self.tmp / ".colab-logs"
        logs_dir.mkdir(parents=True, exist_ok=True)
        stale_log = logs_dir / "s-stale.log"
        stale_log.write_text("Old run log:\nJOB_COMPLETE\n== job complete\n")

        self.set_state(
            sessions_code=0,
            sessions_out="[s-stale] t4\n",
            exec_code=0,
            exec_out="Running new job, but still not finished...\n",
        )
        res = subprocess.run(
            ["bash", str(COLAB_RUN_SH), "zero-shot", "--session", "s-stale", "--max-calls", "1"],
            cwd=str(self.tmp),
            env=self.env,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(res.returncode, 0, "Must not falsely complete based on stale log markers")
        self.assertIn("exhausted 1 calls", res.stdout)

    # 5. recovery failure causes nonzero exit
    def test_recovery_failure_exits_nonzero(self):
        bad_artifact = '{"event": "ARTIFACT", "runId": "run-chk", "name": "bad.json", "bytes": 7, "sha256": "badhash", "inline": "corrupt"}\nJOB_COMPLETE\n'
        self.set_state(
            sessions_code=0,
            sessions_out="[s-rec] t4\n",
            exec_code=0,
            exec_out=bad_artifact,
        )
        res = subprocess.run(
            ["bash", str(COLAB_RUN_SH), "zero-shot", "--session", "s-rec", "--max-calls", "1"],
            cwd=str(self.tmp),
            env=self.env,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(res.returncode, 0, "Must fail if artifact recovery fails checksum validation")
        self.assertIn("Checksum mismatch", res.stderr)

    # 6. released VM with inline artifacts recovers safely and reports missing remote binaries
    def test_released_vm_inline_recovery_and_missing_binary(self):
        log_file = self.tmp / "session.log"
        results_dir = self.tmp / "results"
        payload = {"accuracy": 0.95}
        encoded = (json.dumps(payload, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
        art_inline = {
            "event": "ARTIFACT",
            "runId": "run-rel",
            "name": "metrics.json",
            "bytes": len(encoded),
            "sha256": hashlib.sha256(encoded).hexdigest(),
            "inline": payload,
        }
        art_remote = {
            "event": "ARTIFACT",
            "runId": "run-rel",
            "name": "adapter.safetensors",
            "kind": "adapter",
            "path": "/content/out/run-rel/adapter.safetensors",
        }
        log_file.write_text(f"{json.dumps(art_inline)}\n{json.dumps(art_remote)}\n", encoding="utf-8")

        # colab download fails (VM released)
        self.set_state(download_code=1)
        res = subprocess.run(
            ["python3", str(RECOVER_PY), "s-test", str(log_file), str(results_dir)],
            env=self.env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(res.returncode, 0)
        self.assertTrue((results_dir / "run-rel" / "metrics.json").exists())
        self.assertIn("adapter.safetensors (adapter)", res.stdout)

    # 7. cross-run duplicate artifact names scoped properly without clobbering
    def test_cross_run_duplicate_names_scoped_separately(self):
        log_file = self.tmp / "session.log"
        results_dir = self.tmp / "results"

        p1 = {"version": 1}
        e1 = (json.dumps(p1, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
        art1 = {
            "event": "ARTIFACT",
            "runId": "run-1",
            "name": "scorecard.json",
            "bytes": len(e1),
            "sha256": hashlib.sha256(e1).hexdigest(),
            "inline": p1,
        }

        p2 = {"version": 2}
        e2 = (json.dumps(p2, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
        art2 = {
            "event": "ARTIFACT",
            "runId": "run-2",
            "name": "scorecard.json",
            "bytes": len(e2),
            "sha256": hashlib.sha256(e2).hexdigest(),
            "inline": p2,
        }

        log_file.write_text(f"{json.dumps(art1)}\n{json.dumps(art2)}\n", encoding="utf-8")
        res = subprocess.run(
            ["python3", str(RECOVER_PY), "s-test", str(log_file), str(results_dir)],
            env=self.env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(res.returncode, 0)
        out1 = json.loads((results_dir / "run-1" / "scorecard.json").read_text())
        out2 = json.loads((results_dir / "run-2" / "scorecard.json").read_text())
        self.assertEqual(out1["version"], 1)
        self.assertEqual(out2["version"], 2)

    # 8. path escape is caught and rejected
    def test_path_escape_rejected(self):
        log_file = self.tmp / "escape.log"
        results_dir = self.tmp / "results"
        art_escape = {
            "event": "ARTIFACT",
            "runId": "run-ok",
            "name": "../../evil.txt",
            "inline": "evil",
        }
        log_file.write_text(json.dumps(art_escape) + "\n", encoding="utf-8")
        res = subprocess.run(
            ["python3", str(RECOVER_PY), "s-test", str(log_file), str(results_dir)],
            env=self.env,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("Path escape detected", res.stderr)

    # 9. checksum mismatch is caught and rejected
    def test_checksum_mismatch_rejected(self):
        log_file = self.tmp / "mismatch.log"
        results_dir = self.tmp / "results"
        art_mismatch = {
            "event": "ARTIFACT",
            "runId": "run-mismatch",
            "name": "test.txt",
            "bytes": 4,
            "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
            "inline": "real",
        }
        log_file.write_text(json.dumps(art_mismatch) + "\n", encoding="utf-8")
        res = subprocess.run(
            ["python3", str(RECOVER_PY), "s-test", str(log_file), str(results_dir)],
            env=self.env,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("Checksum mismatch", res.stderr)
        self.assertFalse((results_dir / "run-mismatch" / "test.txt").exists())


if __name__ == "__main__":
    unittest.main()
