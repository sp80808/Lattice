# Daemon API and SDKs

The CLI, HTTP daemon and MCP server share one service layer
(`@lattice/service`), so every surface has the same behaviour and errors. Wire
types live in `@lattice/protocol` (`RunSummary`, `RunDetail`, `DoctorReport`,
`TaskSubmission`, `ApiErrorBody`, ...).

```text
lattice CLI ─┐
HTTP daemon ─┼─> @lattice/service ─> core / runtime / ledger / analytics
MCP server  ─┘
     ▲
@lattice/sdk (TS) · lattice_sdk (Python)
```

## Starting the daemon

```bash
lattice serve                 # 127.0.0.1:4774, default project = cwd
lattice serve --port 0        # pick a free port (printed on stdout)
npm run daemon                # same server, via apps/daemon ($LATTICE_PORT)
```

## HTTP API (v1, provisional)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/health` | — | `{ok, service, version}` (no auth) |
| POST | `/v1/tasks` | `{task, cwd?, mode?, configPath?}` | `RunResult` + `mode`, `runtimeMode`, `configPath` (201) |
| GET | `/v1/tasks` | `?cwd&limit` | `{runs: RunSummary[]}` newest first |
| GET | `/v1/tasks/:id` | `?cwd` | `RunDetail` (summary + latest TAP); `id` = full ID, prefix, or `latest` |
| GET | `/v1/events/:id` | `?cwd` | `{events: RunEvent[]}` |
| POST | `/v1/decide` | `{question, choices, state?, mode?, allowUnknown?, provider?, cwd?}` | `DecisionResult` |
| GET | `/v1/stats` | `?cwd` | calibration `StatsReport` |
| GET | `/v1/doctor` | `?cwd&network=false` | `DoctorReport` |

`mode` on `POST /v1/tasks`:

- `observe` (**daemon default**): repository snapshot + configured verifier; never
  starts model search or coding agents, even when the config says `mode: auto`.
- `configured`: honour the config as written. With `mode: auto` this runs model
  search and coding agents in worktrees; the request blocks until the run ends.
  There is no reviewer over HTTP, so decisions that need human review make the run
  *blocked* rather than auto-approved.

`provider` on `/v1/decide`: `configured` (the project's `models.decision ?? model`)
or `random` (offline baseline).

Errors are `{error, code}` with a stable code:

| HTTP | code |
|---|---|
| 400 | `invalid_request` |
| 401 | `unauthorized` |
| 403 | `forbidden` (bad Host or Origin) |
| 404 | `not_found` |
| 405 | `method_not_allowed` |
| 409 | `conflict` (e.g. ambiguous run-id prefix) |
| 413 / 415 | `payload_too_large` / `unsupported_media_type` |
| 422 | `config_error` (missing/invalid config for what was asked) |
| 500 | `internal_error` |

### Security model

The daemon runs commands and coding agents, so it assumes that any web page open
in your browser could try to reach it:

- it binds `127.0.0.1` only;
- it rejects `Host` headers other than `127.0.0.1`/`localhost`/`[::1]` (DNS rebinding);
- it rejects any request carrying an `Origin` unless allowed with `--origin`;
- `POST` requires `content-type: application/json`, which forces a CORS preflight;
- `--token` / `$LATTICE_DAEMON_TOKEN` requires `Authorization: Bearer <token>` on everything except `/health`;
- run IDs are validated before touching the filesystem.

`cwd` in a request selects any project directory the daemon user can read, so
treat the daemon like a local shell: don't expose it through a proxy.

## TypeScript: `@lattice/sdk`

Zero runtime dependencies (platform `fetch`).

```ts
import { LatticeApiError, LatticeClient } from "@lattice/sdk";

const client = new LatticeClient();            // $LATTICE_URL ?? http://127.0.0.1:4774
await client.waitUntilReady();

const run = await client.runTask("fix the failing parser tests", {
  cwd: "/path/to/repo",
  mode: "observe",                              // or "configured"
});
const runs = await client.listRuns({ cwd: "/path/to/repo", limit: 10 });
const detail = await client.getRun("latest", { cwd: "/path/to/repo" });
const events = await client.getEvents(detail.runId, { cwd: "/path/to/repo" });

const decision = await client.decide({
  question: "Which experiment first?",
  choices: [{ id: "a", label: "Run tests" }, { id: "b", label: "Read logs" }],
  provider: "configured",
  cwd: "/path/to/repo",
});

try {
  await client.getRun("nope");
} catch (error) {
  if (error instanceof LatticeApiError) console.log(error.status, error.code);
}
```

Options: `baseUrl`, `token` (default `$LATTICE_DAEMON_TOKEN`), `timeoutMs`
(default 10 minutes, since auto-mode runs are long), and a custom `fetch`.

To embed the daemon in your own process (tests, editors):

```ts
import { startLatticeServer } from "@lattice/server";
const server = await startLatticeServer({ port: 0, cwd: "/path/to/repo" });
// ... new LatticeClient({ baseUrl: server.url }) ...
await server.close();
```

To skip HTTP entirely, call `@lattice/service` (`executeTask`, `listRuns`, `getRun`,
`decide`, `runDoctor`, ...) or `@lattice/core`'s `runTask` directly. See
[`examples/embedded/offline-search-loop.mjs`](../examples/embedded/offline-search-loop.mjs).

## Python: `lattice_sdk`

Standard library only, Python ≥ 3.9. See [`sdks/python/README.md`](../sdks/python/README.md).

```python
from lattice_sdk import LatticeClient
client = LatticeClient()
run = client.run_task("inspect this repository", cwd="/path/to/repo")
```

## Tests

```bash
npm test                                          # includes SDK <-> real server tests
python3 -m unittest discover -s sdks/python/tests # spawns a real daemon
scripts/check-examples.sh                         # runs every example
```
