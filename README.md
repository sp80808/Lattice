# Lattice

**A fast, low-cost, high-accuracy coding harness and subagent orchestrator.**

Lattice is a CLI/GUI coding harness designed to hide complex agent orchestration behind a simple interface. It combines:

- cheap bounded decision models (initially Qwen-family/local models);
- stronger generative coding models only when useful;
- deterministic verification through compilers, tests, linters and benchmarks;
- parallel subagents isolated by task/evidence boundary;
- compact, provenance-aware repository context;
- Tessera-inspired internal representations for token-efficient agent state.

The goal is not to expose users to a complicated multi-agent framework. The default experience should feel like a straightforward coding assistant:

```bash
lattice
lattice "fix the failing parser tests"
lattice --auto "reduce cache latency without changing the public API"
```

## Core idea

**Generate less. Choose cheaply. Verify everything.**

Instead of repeatedly asking a large model what to do next, Lattice turns uncertainty into small bounded decisions, routes those decisions to the cheapest capable model, executes only promising actions, and uses objective evidence to update the search.

```text
User task
   ↓
Repository/context pack
   ↓
Generate candidate actions
   ↓
Cheap decision/ranking (Qwen/Jev-compatible/local)
   ↓
Top-k experiments
   ↓
Compiler/tests/benchmarks
   ↓
Evidence update
   ↓
Continue / branch / escalate / stop
```

## Tessera relationship

[Tessera](https://github.com/sp80808/Tessera) is the language/research substrate. Lattice is the user-facing harness.

Lattice should be able to use Tessera concepts before the Tessera compiler is complete:

- **TC** — compact canonical representation;
- **TIR** — explicit semantic/debug expansion;
- **TCG** — provenance-aware repository/context graph;
- **TAP** — proposed Lattice/Tessera Agent Packet carrying objective, evidence, hypotheses, constraints, budgets and verification state.

Users should never need to write Tessera to benefit from it.

## Product shape

```text
                 CLI / TUI / Web GUI
                         │
                     lattice
                         │
                  orchestrator
          ┌──────────────┼──────────────┐
          │              │              │
      context         decision       subagents
        TCG          router/search       │
          │              │              │
          └──────────────┼──────────────┘
                         │
                       TAP
          ┌──────────────┼──────────────┐
          │              │              │
        tools          models          agents
       MCP/git     Qwen/API/local   native/adapters
```

## Design principles

1. **Simple defaults** — `mode: auto` should be enough for most users.
2. **Evidence beats model confidence** — compiler/test/benchmark results override model judgement.
3. **Small models first** — use cheap/local models for discrimination and routing; escalate only when needed.
4. **Context is budgeted** — subagents receive only the connected repository context they need.
5. **Parallelism by evidence boundary** — avoid multiple agents blindly editing the same semantic area.
6. **Replayable decisions** — every important decision records candidates, evidence, provider, cost and outcome.
7. **Open ecosystem** — support OpenAI-compatible providers, local Qwen, MCP tools and existing coding-agent ecosystems.
8. **CLI and GUI share one daemon/core** — no separate simplified web implementation.

## Initial runtime direction

Fastest path to an actionable prototype:

- TypeScript core/daemon initially;
- SQLite or append-only JSONL event/evidence store;
- local shell/git/test execution;
- OpenAI-compatible generator interface;
- Qwen/local decision-provider interface;
- MCP server/client support;
- terminal UI first, web GUI against the same local/hosted daemon;
- Rust/WASM only where profiling demonstrates a useful performance win.

See [docs/architecture.md](docs/architecture.md) and [docs/mvp.md](docs/mvp.md).

## Prototype quick start

```bash
scripts/bootstrap.sh --link                      # install, build, test; puts `lattice` on PATH
cd /path/to/your/repo
lattice init                                     # .lattice/config.json (local Qwen via Ollama; verifier auto-detected)
lattice doctor                                   # checks models, worker agent, verifier
lattice "fix the failing parser tests"
lattice runs && lattice show latest
```

No model yet? `lattice init --preset observe` records repository and test evidence only, and
`node examples/embedded/offline-search-loop.mjs` runs the full search loop offline.

Every run writes a versioned TAP task packet and an append-only JSONL event log under `.lattice/runs/`.

| Surface | Entry point | Docs |
|---|---|---|
| CLI | `lattice run / init / doctor / runs / show / config / serve / mcp / stats / mine / policy-sim` | [docs/cli.md](docs/cli.md) |
| HTTP daemon | `lattice serve` (127.0.0.1:4774) | [docs/sdk.md](docs/sdk.md) |
| TypeScript SDK | `@lattice/sdk` | [docs/sdk.md](docs/sdk.md) |
| Python SDK | `sdks/python` (`lattice_sdk`) | [sdks/python/README.md](sdks/python/README.md) |
| MCP server | `lattice mcp` for Claude Code, Codex, Cursor, Gemini CLI | [docs/integrations.md](docs/integrations.md) |
| Setup scripts | `scripts/bootstrap.sh`, `setup-provider.sh`, `setup-agents.sh` | [docs/integrations.md](docs/integrations.md) |
| Examples | runnable demos, configs, client snippets | [examples/README.md](examples/README.md) |

The architecture deliberately uses open-source projects as jumping-off points rather than rebuilding commodity plumbing. See [open-source jumping-off points](docs/open-source-jumping-off-points.md).

## Status

Early runnable bootstrap. APIs and representations are intentionally provisional until benchmarked.
