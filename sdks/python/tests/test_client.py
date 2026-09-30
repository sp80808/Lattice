"""Integration tests against a real Lattice daemon (requires `npm run build`)."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lattice_sdk import LatticeApiError, LatticeClient  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
CLI = REPO / "apps" / "cli" / "dist" / "index.js"
NODE = shutil.which("node")


@unittest.skipUnless(NODE and CLI.exists(), "node and a built CLI (npm run build) are required")
class DaemonIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.project = tempfile.mkdtemp(prefix="lattice-py-")
        env = {**os.environ, "LATTICE_DAEMON_TOKEN": "py-token", "LATTICE_CONFIG": ""}
        cls.daemon = subprocess.Popen(
            [NODE, str(CLI), "serve", "--port", "0", "-C", cls.project],
            stdout=subprocess.PIPE,
            env=env,
            text=True,
        )
        line = cls.daemon.stdout.readline()
        match = re.search(r"http://127\.0\.0\.1:\d+", line)
        if not match:
            cls.daemon.kill()
            raise RuntimeError(f"daemon did not report its URL: {line!r}")
        cls.client = LatticeClient(match.group(0), token="py-token")
        cls.client.wait_until_ready()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.daemon.terminate()
        cls.daemon.wait(timeout=10)
        cls.daemon.stdout.close()
        shutil.rmtree(cls.project, ignore_errors=True)

    def test_run_list_show_events(self) -> None:
        run = self.client.run_task("inspect from python")
        self.assertEqual(run["mode"], "observe")
        self.assertEqual(run["tap"]["task"], "inspect from python")

        runs = self.client.list_runs(limit=5)
        self.assertIn(run["runId"], [item["runId"] for item in runs])

        detail = self.client.get_run(run["runId"][:8])
        self.assertEqual(detail["runId"], run["runId"])
        self.assertEqual(detail["status"], "completed")

        events = self.client.get_events(run["runId"])
        self.assertEqual(events[0]["type"], "run.started")

    def test_decide_stats_doctor(self) -> None:
        decision = self.client.decide(
            "Which first?",
            [{"id": "a", "label": "Run tests"}, {"id": "b", "label": "Read logs"}],
            provider="random",
        )
        self.assertEqual(decision["identity"]["provider"], "random")
        self.assertIsInstance(self.client.stats(), dict)
        doctor = self.client.doctor(network=False)
        self.assertEqual(Path(doctor["cwd"]).resolve(), Path(self.project).resolve())
        self.assertIn("node", [check["id"] for check in doctor["checks"]])

    def test_submit_stream_and_wait(self) -> None:
        accepted = self.client.submit_task("async from python")
        self.assertEqual(accepted["status"], "running")

        types = [event["type"] for event in self.client.stream_events(accepted["runId"])]
        self.assertEqual(types[0], "run.started")
        self.assertEqual(types[-1], "run.completed")

        resumed = [event["seq"] for event in self.client.stream_events(accepted["runId"], after=3)]
        self.assertEqual(resumed[0], 4)

        self.assertEqual(self.client.wait_for_run(accepted["runId"])["status"], "completed")

        with self.assertRaises(LatticeApiError) as caught:
            list(self.client.stream_events("deadbeef"))
        self.assertEqual(caught.exception.status, 404)

    def test_review_endpoints(self) -> None:
        self.assertEqual(self.client.list_reviews(), [])
        with self.assertRaises(LatticeApiError) as caught:
            self.client.get_review("latest")
        self.assertEqual(caught.exception.status, 404)
        with self.assertRaises(LatticeApiError) as caught:
            self.client.answer_review("deadbeef", "approve")
        self.assertEqual(caught.exception.code, "not_found")
        with self.assertRaises(LatticeApiError):
            self.client.wait_for_review("deadbeef", timeout=0.3, interval=0.1)
        # Observe mode never needs review, so remote review is a harmless no-op.
        run = self.client.run_task("observe with remote review", review="remote")
        self.assertEqual(run["status"], "completed")

    def test_errors_are_typed(self) -> None:
        with self.assertRaises(LatticeApiError) as caught:
            self.client.run_task("   ")
        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(caught.exception.code, "invalid_request")

        with self.assertRaises(LatticeApiError) as caught:
            self.client.get_run("deadbeef")
        self.assertEqual(caught.exception.status, 404)

        anonymous = LatticeClient(self.client.base_url, token="")
        with self.assertRaises(LatticeApiError) as caught:
            anonymous.list_runs()
        self.assertEqual(caught.exception.status, 401)


if __name__ == "__main__":
    unittest.main()
