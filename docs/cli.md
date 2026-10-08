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
| `--intent <i>` | `plan`/`review`: read the repository only; `debug`: also run the verifier; `act`/`auto` (default): whatever the config grants |
| `--json` | print the `RunResult` plus `mode`, `intent`, `runtimeMode`, `configPath` |

Without a config the run is *evidence-only* (repository snapshot). With
`mode: auto` it runs the model search loop and coding agents in isolated
worktrees; supervised/manual autonomy prompts at the TTY and blocks without one.

`--intent` is enforced by what the runtime builds, not by a prompt: under
`plan`, `review` or `debug` no model search, coding agent or worktree is
created at all, and under `plan`/`review` the verifier does not run either
(running tests executes repository code). An intent can only narrow the
config: `--intent act` on a `mode: observe` config still only observes. The
run's `run.started` event records the intent and the resulting
`read`/`verify`/`search`/`agent` grants. The daemon (`POST /v1/tasks`), SDKs
and the `lattice_run` MCP tool take the same `intent` field.

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
