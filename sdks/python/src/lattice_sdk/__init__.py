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
from typing import Any, Dict, List, Literal, Optional, Sequence, TypedDict

__all__ = [
    "DEFAULT_LATTICE_URL",
    "DecisionChoice",
    "LatticeApiError",
    "LatticeClient",
]

__version__ = "0.0.1"

DEFAULT_LATTICE_URL = "http://127.0.0.1:4774"

TaskMode = Literal["observe", "configured"]
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
        config_path: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Run a task. ``mode="observe"`` (daemon default) never launches coding agents."""
        body = _drop_none({"task": task, "cwd": cwd, "mode": mode, "configPath": config_path})
        return self._request("POST", "/v1/tasks", body=body)

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
            with error:
                raw = error.read()
            try:
                payload = json.loads(raw) if raw else {}
            except ValueError:
                payload = {}
            raise LatticeApiError(
                error.code,
                payload.get("code", "http_error"),
                payload.get("error", f"HTTP {error.code}: {raw[:200]!r}"),
            ) from None
        return json.loads(raw) if raw else None
