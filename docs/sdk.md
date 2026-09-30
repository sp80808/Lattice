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
| GET | `/health` | — | `{ok, service, version, activeRuns}` (no auth) |
| POST | `/v1/tasks` | `{task, cwd?, mode?, configPath?, wait?}` | `RunResult` + `mode`, `runtimeMode`, `configPath` (201); with `wait: false`, `TaskAccepted` (202) as soon as the run starts |
| GET | `/v1/tasks` | `?cwd&limit` | `{runs: RunSummary[]}` newest first |
| GET | `/v1/tasks/:id` | `?cwd` | `RunDetail` (summary + latest TAP); `id` = full ID, prefix, or `latest` |
| GET | `/v1/events/:id` | `?cwd` | `{events: RunEvent[]}` |
| GET | `/v1/events/:id?follow=true` | `?cwd&after`, or `Accept: text/event-stream` | server-sent events until the run completes or fails |
| POST | `/v1/decide` | `{question, choices, state?, mode?, allowUnknown?, provider?, cwd?}` | `DecisionResult` |
| GET | `/v1/reviews` | — | `{reviews: PendingReview[]}` waiting on this daemon |
| GET | `/v1/reviews/:runId` | — | one `PendingReview` (run ID, prefix, or `latest`) |
| POST | `/v1/reviews/:runId` | `{action, selected?, note?, reviewId?}` | `{runId, reviewId, accepted}`; the run resumes |
| GET | `/v1/stats` | `?cwd` | calibration `StatsReport` |
| GET | `/v1/doctor` | `?cwd&network=false` | `DoctorReport` |

`mode` on `POST /v1/tasks`:

- `observe` (**daemon default**): repository snapshot + configured verifier; never
  starts model search or coding agents, even when the config says `mode: auto`.
- `configured`: honour the config as written. With `mode: auto` this runs model
  search and coding agents in worktrees; the request blocks until the run ends.
  Decisions that need human review make the run *blocked* rather than
  auto-approved, unless you submit with `review: "remote"` (see below).

### Long runs: async submission and streaming

`POST /v1/tasks` with `"wait": false` validates the request and config, starts
the run, and returns `202`:

```json
{"runId": "…", "status": "running", "startedAt": "…", "mode": "configured",
 "links": {"run": "/v1/tasks/…", "events": "/v1/events/…?follow=true"}}
```

Invalid input and config errors still fail synchronously (400/422); failures
after the run starts are recorded in its log as `run.failed`.

`GET /v1/events/:id?follow=true` streams the run as SSE. Each frame is
`id: <seq>` plus `data: <RunEvent JSON>`. The stream replays earlier events,
tails new ones, and closes after `run.completed` or `run.failed`. Resume with
`?after=<seq>` or the standard `Last-Event-ID` header. A `: keepalive` comment
is sent every 15 s. Streaming works for any run, including ones started by the
CLI or another daemon, because it tails the JSONL log.

```bash
curl -N "http://127.0.0.1:4774/v1/events/latest?follow=true"
```

### Remote review (supervised / manual autonomy)

With `autonomy.mode` `supervised` or `manual`, some decisions need a reviewer.
The CLI asks at the TTY. Over HTTP there is no TTY, so by default those runs
end *blocked* instead of auto-approving.

Submit with `"review": "remote"` to have the run pause instead. The request
shows up in `GET /v1/reviews` and on the run's event stream as a
`decision.completed` event whose payload `type` is `decision.review.requested`.
Answer it with `POST /v1/reviews/:runId`:

| action | effect |
|---|---|
| `approve` | run the model's pick |
| `replace` | run `selected` instead (IDs from `choices`, excluding `__none__`) |
| `refine` | regenerate candidates, with `note` added to the context |
| `stop` | end the run as blocked |

Pass the `reviewId` you were shown: answering a stale round returns `409`. An
unanswered review stops the run after `reviewTimeoutMs` (default 10 minutes).
Pending reviews live in the daemon process, so a daemon restart forgets them
(the run itself is lost too).

```ts
const accepted = await client.submitTask("fix the add test", { mode: "configured", review: "remote" });
const pending = await client.waitForReview(accepted.runId);
await client.answerReview(accepted.runId, { action: "replace", selected: ["fix-add"], reviewId: pending.reviewId });
const final = await client.waitForRun(accepted.runId);
```

See [`examples/review/remote-reviewer.mjs`](../examples/review/remote-reviewer.mjs).

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

// Long runs: don't block, stream progress instead.
const accepted = await client.submitTask("fix the flaky test", { cwd: "/path/to/repo", mode: "configured" });
for await (const event of client.streamEvents(accepted.runId, { cwd: "/path/to/repo" })) {
  console.log(event.seq, event.type);
}
const final = await client.waitForRun(accepted.runId, { cwd: "/path/to/repo" }); // or just wait

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
