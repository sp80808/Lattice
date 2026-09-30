# lattice-sdk (Python)

Standard-library-only client for the Lattice daemon. Responses are plain `dict`s
matching the wire types in `packages/protocol/src/index.ts`.

```bash
lattice serve                      # or: npm run daemon (from the repo root)
pip install -e sdks/python         # or add sdks/python/src to PYTHONPATH
```

```python
from lattice_sdk import LatticeApiError, LatticeClient

client = LatticeClient()           # $LATTICE_URL, default http://127.0.0.1:4774
client.wait_until_ready()

run = client.run_task("inspect this repository", cwd="/path/to/repo")   # mode="observe" by default
print(run["runId"], run["summary"])

for summary in client.list_runs(cwd="/path/to/repo", limit=5):
    print(summary["runId"][:8], summary["status"], summary["task"])

detail = client.get_run("latest", cwd="/path/to/repo")   # includes the TAP packet
events = client.get_events(detail["runId"], cwd="/path/to/repo")

choice = client.decide(
    "Which experiment is cheapest and most informative?",
    [{"id": "tests", "label": "Run the failing test"}, {"id": "logs", "label": "Read CI logs"}],
    provider="random",             # "configured" uses the project's decision model
)

try:
    client.get_run("deadbeef")
except LatticeApiError as error:
    print(error.status, error.code)  # 404 not_found
```

`mode="configured"` honours `.lattice/config.json`; with `mode: auto` that runs
model search and coding agents in isolated worktrees and can take minutes (the
default client timeout is 600 s).

Auth: if the daemon was started with `--token` / `$LATTICE_DAEMON_TOKEN`, pass
`token=` or set `LATTICE_DAEMON_TOKEN` in the client environment.

Tests (spawn a real daemon; run `npm run build` first):

```bash
python3 -m unittest discover -s sdks/python/tests -v
```
