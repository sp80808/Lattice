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

### `lattice plan <task...> --file <path[:start-end]>`

Creates a Markdown implementation plan from an explicit, bounded source set.
Repeat `--file` for each relevant file or line range. Planning requires a
configured generator and records its receipt outside the target project when
`--lattice-dir` is supplied.

Uses `models.generator` or `model`; no agent or verifier is needed. Selected
source excerpts go to that configured provider. Each receipt records source
hashes and line ranges, provider identity, usage, and the draft. Model advice
remains unverified: completion means a draft was generated, not that its claims
or implementation passed tests. Configured agents and verification commands do
not run during planning.

Select 1–24 repository-relative UTF-8 files or inclusive line ranges, at most
512 KiB per source file and 96 KiB of numbered excerpt context. Sources outside
the repository (including symlink escapes), common private configuration paths,
binary/empty files and invalid ranges are rejected. Narrow ranges when the
context is too large. The built-in HTTP generator requests at most 4096 output
tokens and rejects token-truncated responses.

```bash
lattice plan "add a fourth island" \
  --file web/src/store/gameStore.ts:280-329 \
  --file web/src/game/boardThemes.ts:1-135 \
  --file web/tests/store.test.mjs:322-373 \
  --lattice-dir /tmp/blockbound-lattice
```

| Flag | Meaning |
|---|---|
| `--file <path[:start-end]>` | required, repeatable source selection |
| `--config <path>` | explicit generator config |
| `--lattice-dir <path>` | directory for Lattice run receipts |
| `--json` | print the complete `RunResult`; otherwise print the plan and send the receipt path to stderr |

For a replayable Blockbound trial with an existing Codex login, see
[the embedded planning example](../examples/planning/README.md).

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

## Benchmarks

### `lattice bench [suite-dir] [flags]`

Runs a deterministic fixture suite across decision strategies and reports
orchestration quality (see [benchmarks.md](benchmarks.md) for the suite format).

| Flag | Default | Meaning |
|---|---|---|
| `-s, --strategies <a,b>` | `first,random,cheapest-first,oracle` | strategies to compare; `configured` needs `--config` |
| `-n, --trials <N>` | `40` | trials for nondeterministic strategies (`random`, `configured`) |
| `--seed <N>` | `1` | base seed; trial *i* uses `seed + i` |
| `--rounds <N>` | `2` | per-trial round budget; half the candidate budget by design |
| `--task <id>` | all | repeatable task filter |
| `-j, --concurrency <N>` | `1` | trials in flight; results stay deterministic and ordered |
| `--shard <i/n>` | — | run task shard *i* of *n* (for parallel CI) |
| `--baseline <file.json>` | — | compare against a previous report; exits `1` on regression |
| `-o, --out <file.json>` | — | write the full JSON report |
| `--check` | — | self-check: every task must fail as shipped and pass with its solution |
| `--config <path>` | — | config providing the `configured` decision model |

`--baseline` compares per-strategy solve rates and prints
`REGRESSED <strategy>: 67% -> 0%` lines; any drop beyond tolerance exits `1`,
which makes it usable as a CI gate. `pass@k`, tokens, cost and a per-task /
per-difficulty breakdown are part of the report.

## Replay analytics

Unchanged: `lattice stats`, `lattice mine`, `lattice policy-sim` (see
[calibration.md](calibration.md), [consolidation.md](consolidation.md),
[policy-simulation.md](policy-simulation.md)).
