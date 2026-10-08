# CLI reference

```bash
npm run build
node apps/cli/dist/index.js --help     # or `scripts/bootstrap.sh --link` to get `lattice` on PATH
```

Every command accepts `-C, --cwd <dir>` (before or after the command name) and
most accept `--json` for machine-readable output. Exit codes: `0` success, `1`
failure (including `doctor` finding a ✗), `2` usage error.

## Tasks

### `lattice run <task...>` / `lattice "<task>"`

Runs a task in the current project. Anything that is not a command name is
treated as a task, so `lattice "fix the parser tests"` is shorthand.

| Flag | Meaning |
|---|---|
| `--config <path>` | explicit config (otherwise `$LATTICE_CONFIG`, `.lattice/config.json`, `lattice.config.json`) |
| `--observe` | gather evidence and run the verifier only, even if the config says `mode: auto` |
| `--json` | print the `RunResult` plus `mode`, `runtimeMode`, `configPath` |

Without a config the run is *evidence-only* (repository snapshot). With
`mode: auto` it runs the model search loop and coding agents in isolated
worktrees; supervised/manual autonomy prompts at the TTY and blocks without one.

### `lattice replay [id|latest] [--json]`

Re-runs a run made with `lattice run --record` using only its recorded I/O.
`--record` writes `.lattice/runs/<id>.cassette.jsonl`: one line per model,
verify command, structured verifier and experiment call, holding the
canonical request and its response (or error). Cassettes contain prompts,
model replies and command output; they stay on disk next to the run log.

Replay builds the run from the current config exactly as before, but every
one of those calls is served from the cassette and none reaches a model, a
command or a coding agent. Calls must arrive in the recorded order with the
recorded request; the first that does not is reported as the divergence, with
its call number, kind and the request fields that changed (for example
`call 1 (command): request changed in args` after editing `verify`). A replay
that makes fewer or more calls than the recording also diverges. The replay is
a new run whose `run.started` event carries `lineage.replayOf`. Exit status is
0 only when nothing diverged and the outcome matches the recording.

Forking a run at an event and refreshing selected calls live are not
implemented yet (#51).

### `lattice runs [-n N] [--json]`

Recorded runs in `.lattice/runs/`, newest first, with status (`completed`,
`failed`, or `incomplete` for a run that is still going or crashed) and
evidence/decision/experiment counts.

### `lattice show [id|latest] [--events] [--json]`

One run: status, summary or error, the TAP packet's evidence and
uncertainties, and the log path. `id` may be a full ID or any unambiguous
prefix. `--events` prints the raw event timeline. `-f, --follow` tails a run
that is still going (for example one submitted to the daemon), printing events
as they are logged and the final summary when it ends (`--json` prints one
event per line).

## Setup

### `lattice init`

Writes `.lattice/config.json` (and `.lattice/.gitignore` ignoring `runs/`).

| Flag | Default |
|---|---|
| `--preset` | `ollama` (`http://127.0.0.1:11434/v1`, model `qwen3-coder`); also `vllm` (`:8000/v1`, `--model` required), `openai-compatible` (`--base-url` and `--model` required, key from `$LATTICE_API_KEY`), `observe` |
| `--model`, `--base-url`, `--api-key-env` | override the preset |
| `--agent` | `qwen-code` (approval `auto-edit`) or `opencode` |
| `--verify "cmd args"` | auto-detected: `npm test`, `cargo test`, `go test ./...`, `python3 -m pytest`, `make test`. Split on whitespace; no shell parsing |
| `--no-verify` | skip detection |
| `--autonomy` | `supervised` |
| `--force` | overwrite an existing config |
| `--print` | print the config instead of writing it |

If no verifier is found, `init` writes `mode: observe` and tells you so,
because auto mode refuses to search without objective verification.

### `lattice doctor [--offline] [--config p] [--json]`

Checks Node ≥ 22, git/worktree availability, config validity, auto-mode
completeness, API-key environment variables, model endpoint reachability
(`GET <baseUrl>/models`, and whether the model is listed), coding-agent binary
and verifier binary. `--offline` skips network probes.

### `lattice config [--config p] [--json]`

Prints the resolved config and where it came from.

## Integrations

### `lattice serve [--port 4774] [--token t] [--origin url ...]`

Starts the HTTP daemon on `127.0.0.1` (see [sdk.md](sdk.md)). `--port 0`
picks a free port. The token defaults to `$LATTICE_DAEMON_TOKEN`.

### `lattice mcp`

Serves MCP over stdio for Claude Code, Codex, Cursor, Gemini CLI and others
(see [integrations.md](integrations.md)).

## Replay analytics

Unchanged: `lattice stats`, `lattice mine`, `lattice policy-sim` (see
[calibration.md](calibration.md), [consolidation.md](consolidation.md),
[policy-simulation.md](policy-simulation.md)).
