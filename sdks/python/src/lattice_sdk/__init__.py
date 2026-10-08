"""Python client for the Lattice daemon HTTP API.

Standard library only. Responses are plain dicts matching the wire types in
``packages/protocol/src/index.ts`` (RunSummary, RunDetail, DoctorReport, ...).

    from lattice_sdk import LatticeClient

    client = LatticeClient()                     # $LATTICE_URL or http://127.0.0.1:4774
    run = client.run_task("inspect this repository", cwd="/path/to/repo")
    print(run["runId"], run["summary"])
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterator, List, Literal, Optional, Sequence, TypedDict

__all__ = [
    "DEFAULT_LATTICE_URL",
    "DecisionChoice",
    "LatticeApiError",
    "LatticeClient",
]

__version__ = "0.0.1"

DEFAULT_LATTICE_URL = "http://127.0.0.1:4774"

TaskMode = Literal["observe", "configured"]
ReviewMode = Literal["none", "remote"]
TaskIntent = Literal["auto", "plan", "act", "debug", "review"]
ReviewAction = Literal["approve", "replace", "refine", "stop"]
DecisionProviderName = Literal["configured", "random"]


class _DecisionChoiceRequired(TypedDict):
    id: str
    label: str


class DecisionChoice(_DecisionChoiceRequired, total=False):
    detail: str


class LatticeApiError(Exception):
    """Non-2xx response from the daemon. ``code`` is stable; the message is for humans."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code

    def __repr__(self) -> str:
        return f"LatticeApiError(status={self.status}, code={self.code!r}, message={str(self)!r})"


def _drop_none(values: Dict[str, Any]) -> Dict[str, Any]:
    return {key: value for key, value in values.items() if value is not None}


class LatticeClient:
    """Thin, typed-by-convention wrapper over the daemon's JSON API."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        timeout: float = 600.0,
    ) -> None:
        self.base_url = (base_url or os.environ.get("LATTICE_URL") or DEFAULT_LATTICE_URL).rstrip("/")
        self.token = token if token is not None else os.environ.get("LATTICE_DAEMON_TOKEN") or None
        self.timeout = timeout

    # -- health ------------------------------------------------------------

    def health(self) -> Dict[str, Any]:
        return self._request("GET", "/health")

    def wait_until_ready(self, timeout: float = 10.0, interval: float = 0.2) -> Dict[str, Any]:
        """Poll /health until the daemon answers or ``timeout`` seconds pass."""
        deadline = time.monotonic() + timeout
        last: Optional[Exception] = None
        while time.monotonic() < deadline:
            try:
                return self.health()
            except (OSError, LatticeApiError) as error:  # URLError is an OSError
                last = error
                time.sleep(interval)
        raise TimeoutError(f"Lattice daemon at {self.base_url} not ready after {timeout}s: {last}")

    # -- tasks & runs --------------------------------------------------------

    def run_task(
        self,
        task: str,
        *,
        cwd: Optional[str] = None,
        mode: Optional[TaskMode] = None,
        intent: Optional[TaskIntent] = None,
        config_path: Optional[str] = None,
        review: Optional[ReviewMode] = None,
    ) -> Dict[str, Any]:
        """Run a task. ``mode="observe"`` (daemon default) never launches coding agents."""
        body = _drop_none(
            {"task": task, "cwd": cwd, "mode": mode, "intent": intent, "configPath": config_path, "review": review}
        )
        return self._request("POST", "/v1/tasks", body=body)

    def submit_task(
        self,
        task: str,
        *,
        cwd: Optional[str] = None,
        mode: Optional[TaskMode] = None,
        intent: Optional[TaskIntent] = None,
        config_path: Optional[str] = None,
        review: Optional[ReviewMode] = None,
    ) -> Dict[str, Any]:
        """Start a task and return as soon as it is running (``{"runId", "status": "running", ...}``)."""
        body = _drop_none(
            {
                "task": task,
                "cwd": cwd,
                "mode": mode,
                "intent": intent,
                "configPath": config_path,
                "review": review,
                "wait": False,
            }
        )
        return self._request("POST", "/v1/tasks", body=body)

    def stream_events(
        self,
        run_id: str,
        *,
        cwd: Optional[str] = None,
        after: Optional[int] = None,
    ) -> Iterator[Dict[str, Any]]:
        """Yield a run's events (server-sent events) until it completes or fails.

        Earlier events are replayed first, so this is safe to call right after
        ``submit_task``. Pass ``after=<seq>`` to resume.
        """
        path = f"/v1/events/{urllib.parse.quote(run_id, safe='')}"
        url = self.base_url + path + "?" + urllib.parse.urlencode(
            _drop_none({"follow": "true", "cwd": cwd, "after": after})
        )
        headers = {"accept": "text/event-stream"}
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(url, headers=headers, method="GET")
        try:
            response = urllib.request.urlopen(request, timeout=self.timeout)
        except urllib.error.HTTPError as error:
            raise self._api_error(error) from None
        with response:
            data: List[str] = []
            for raw_line in response:
                line = raw_line.decode("utf-8").rstrip("\r\n")
                if line.startswith("data:"):
                    value = line[5:]
                    data.append(value[1:] if value.startswith(" ") else value)
                elif line == "" and data:
                    yield json.loads("\n".join(data))
                    data = []

    def wait_for_run(self, run_id: str, *, cwd: Optional[str] = None) -> Dict[str, Any]:
        """Follow a run to completion and return its final detail."""
        resolved = run_id
        for event in self.stream_events(run_id, cwd=cwd):
            resolved = event["runId"]
        return self.get_run(resolved, cwd=cwd)

    # -- remote review ---------------------------------------------------------

    def list_reviews(self) -> List[Dict[str, Any]]:
        """Decisions from ``review="remote"`` runs waiting for an answer on this daemon."""
        return self._request("GET", "/v1/reviews")["reviews"]

    def get_review(self, run_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v1/reviews/{urllib.parse.quote(run_id, safe='')}")

    def answer_review(
        self,
        run_id: str,
        action: ReviewAction,
        *,
        selected: Optional[Sequence[str]] = None,
        note: Optional[str] = None,
        review_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Answer a pending review; pass ``review_id`` to guard against a stale round."""
        body = _drop_none(
            {
                "action": action,
                "selected": list(selected) if selected is not None else None,
                "note": note,
                "reviewId": review_id,
            }
        )
        return self._request("POST", f"/v1/reviews/{urllib.parse.quote(run_id, safe='')}", body=body)

    def wait_for_review(self, run_id: str, timeout: float = 60.0, interval: float = 0.2) -> Dict[str, Any]:
        """Poll until ``run_id`` has a pending review."""
        deadline = time.monotonic() + timeout
        while True:
            try:
                return self.get_review(run_id)
            except LatticeApiError as error:
                if error.status != 404 or time.monotonic() > deadline:
                    raise
            time.sleep(interval)

    def list_runs(self, *, cwd: Optional[str] = None, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        return self._request("GET", "/v1/tasks", query={"cwd": cwd, "limit": limit})["runs"]

    def get_run(self, run_id: str, *, cwd: Optional[str] = None) -> Dict[str, Any]:
        """``run_id`` may be a full ID, an unambiguous prefix, or ``"latest"``."""
        return self._request("GET", f"/v1/tasks/{urllib.parse.quote(run_id, safe='')}", query={"cwd": cwd})

    def get_events(self, run_id: str, *, cwd: Optional[str] = None) -> List[Dict[str, Any]]:
        path = f"/v1/events/{urllib.parse.quote(run_id, safe='')}"
        return self._request("GET", path, query={"cwd": cwd})["events"]

    # -- decisions & diagnostics -----------------------------------------------

    def decide(
        self,
        question: str,
        choices: Sequence[DecisionChoice],
        *,
        state: Optional[str] = None,
        mode: Optional[str] = None,
        allow_unknown: Optional[bool] = None,
        provider: Optional[DecisionProviderName] = None,
        cwd: Optional[str] = None,
    ) -> Dict[str, Any]:
        body = _drop_none(
            {
                "question": question,
                "choices": list(choices),
                "state": state,
                "mode": mode,
                "allowUnknown": allow_unknown,
                "provider": provider,
                "cwd": cwd,
            }
        )
        return self._request("POST", "/v1/decide", body=body)

    def stats(self, *, cwd: Optional[str] = None) -> Dict[str, Any]:
        return self._request("GET", "/v1/stats", query={"cwd": cwd})

    def doctor(self, *, cwd: Optional[str] = None, network: bool = True) -> Dict[str, Any]:
        return self._request("GET", "/v1/doctor", query={"cwd": cwd, "network": None if network else "false"})

    # -- transport -------------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Optional[Dict[str, Any]] = None,
        query: Optional[Dict[str, Any]] = None,
    ) -> Any:
        url = self.base_url + path
        params = _drop_none(query or {})
        if params:
            url += "?" + urllib.parse.urlencode(params)

        headers = {"accept": "application/json"}
        data = None
        if body is not None:
            headers["content-type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"

        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            raise self._api_error(error) from None
        return json.loads(raw) if raw else None

    @staticmethod
    def _api_error(error: urllib.error.HTTPError) -> LatticeApiError:
        with error:
            raw = error.read()
        try:
            payload = json.loads(raw) if raw else {}
        except ValueError:
            payload = {}
        return LatticeApiError(
            error.code,
            payload.get("code", "http_error"),
            payload.get("error", f"HTTP {error.code}: {raw[:200]!r}"),
        )
