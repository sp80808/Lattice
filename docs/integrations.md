# Setup scripts and agent integrations

Three scripts cover the three kinds of setup. All take `--help` and `--dry-run`,
and run on macOS's stock bash 3.2.

| Script | Sets up |
|---|---|
| `scripts/bootstrap.sh` | this checkout: toolchain checks, `npm install`, build, tests, CLI smoke test; `--link` puts `lattice` on PATH, `--python` also runs the Python SDK tests |
| `scripts/setup-provider.sh` | a project's model provider: checks the Ollama/vLLM/hosted endpoint, optionally `ollama pull`s the model (`--pull`), writes `.lattice/config.json` via `lattice init`, runs `lattice doctor` |
| `scripts/setup-agents.sh` | coding-agent clients: registers `lattice mcp` with Claude Code, Codex, Gemini CLI or Cursor, and checks the worker agents Lattice drives (`qwen`, `opencode`) |
| `scripts/check-examples.sh` | validates example configs and runs every example (CI) |

Typical first run:

```bash
scripts/bootstrap.sh --link
scripts/setup-provider.sh --project ~/code/app --pull          # local Qwen via Ollama
scripts/setup-agents.sh --project ~/code/app --client claude
cd ~/code/app && lattice doctor && lattice "fix the failing tests"
```

## Providers

```bash
# Ollama (default): http://127.0.0.1:11434/v1, model qwen3-coder
scripts/setup-provider.sh --project . [--model qwen3-coder:30b] [--pull]

# vLLM
scripts/setup-provider.sh --provider vllm --model Qwen/Qwen3-Coder-30B-A3B-Instruct

# Any hosted OpenAI-compatible API; the key stays in the environment
export MY_KEY=...
scripts/setup-provider.sh --provider openai-compatible \
  --base-url https://api.example.com/v1 --model some-model --api-key-env MY_KEY
```

Use `--agent opencode` to switch the worker preset and `--verify "cargo test"` to
override verifier detection. For separate decision and generator models, edit the
config by hand (see [`examples/configs/vllm-split-models.json`](../examples/configs/vllm-split-models.json)).

## Lattice as an MCP server

`lattice mcp` speaks MCP (JSON-RPC over newline-delimited stdio; protocol
versions 2025-06-18, 2025-03-26 and 2024-11-05). Tools:

| Tool | Read-only | Purpose |
|---|---|---|
| `lattice_run` | no | run a task; `mode=observe` (default) or `configured` |
| `lattice_runs` | yes | list runs |
| `lattice_show_run` | yes | run status + TAP packet |
| `lattice_decide` | yes | bounded decision via the configured decision model (or `random`) |
| `lattice_stats` | yes | calibration stats |
| `lattice_doctor` | yes | setup checks |

The architecture sketch named these `lattice.run`, `lattice.decide`, etc.;
underscores are used because not every MCP client accepts dots in tool names.

Tool failures come back as results with `isError: true` and a `code: message` text,
so the calling model can read and react to them.

### Registering

```bash
scripts/setup-agents.sh --client claude --project ~/code/app            # writes ~/code/app/.mcp.json
scripts/setup-agents.sh --client claude --scope user                    # all projects
scripts/setup-agents.sh --client codex                                  # ~/.codex/config.toml (global)
scripts/setup-agents.sh --client cursor --project ~/code/app            # merges .cursor/mcp.json
scripts/setup-agents.sh --client gemini --project ~/code/app
scripts/setup-agents.sh --client all --dry-run                          # see what would happen
scripts/setup-agents.sh                                                 # just print a generic JSON block
```

Existing registrations are left alone unless you pass `--force`. The server
resolves the project from its working directory, which Claude Code, Cursor and
Gemini set to the project root. Desktop clients with no project directory should
pin it with `lattice mcp -C /path/to/project` (the generic block does this).

Hand-written snippets are in [`examples/mcp/`](../examples/mcp/), and
[`examples/mcp/raw-session.mjs`](../examples/mcp/raw-session.mjs) shows the raw
protocol exchange.

## Worker agents (Lattice drives them)

With `mode: auto`, Lattice launches a coding agent per selected experiment in
a detached git worktree (see [agents.md](agents.md)):

| Preset | Binary | Install |
|---|---|---|
| `qwen-code` | `qwen` | `npm install -g @qwen-code/qwen-code` |
| `opencode` | `opencode` | https://opencode.ai |

`lattice doctor` and `scripts/setup-agents.sh` both report whether the configured
worker is on PATH. The scripts never install workers for you.
