# Lattice examples

Everything here runs offline after `npm run build` unless noted. `scripts/check-examples.sh`
runs all of them (CI does too).

| Example | What it shows | Run |
|---|---|---|
| [`demo/run-demo.sh`](demo/run-demo.sh) | CLI walkthrough: `init` → `doctor` → run → `runs` → `show` on a repo with a failing test | `examples/demo/run-demo.sh` |
| [`embedded/offline-search-loop.mjs`](embedded/offline-search-loop.mjs) | Embedding `@lattice/core`'s search loop with your own generator, decision provider and executor; the bug is fixed and *proven* fixed by test evidence | `node examples/embedded/offline-search-loop.mjs` |
| [`sdk/typescript/run-and-inspect.mjs`](sdk/typescript/run-and-inspect.mjs) | `@lattice/sdk` against the daemon: run, list, show, events, decide, doctor, typed errors | `node examples/sdk/typescript/run-and-inspect.mjs` |
| [`sdk/python/run_and_inspect.py`](sdk/python/run_and_inspect.py) | The same flow with the stdlib-only Python client | `python3 examples/sdk/python/run_and_inspect.py` |
| [`review/remote-reviewer.mjs`](review/remote-reviewer.mjs) | A full **auto-mode** run (fake model, real worktree + tests) where a program answers Lattice's manual-mode review over the API, streaming events via SSE | `node examples/review/remote-reviewer.mjs` |
| [`tessera-repair/compare.mjs`](tessera-repair/compare.mjs) | The MVP slice: repair broken Tessera programs where only `tsr witness` decides success, and compare a decider against random choice on rounds, tokens and cost. Needs a `tsr` build (`TSR=/path/to/tsr`) | `node examples/tessera-repair/compare.mjs` |
| [`mcp/raw-session.mjs`](mcp/raw-session.mjs) | A raw MCP JSON-RPC session with `lattice mcp` (debug integrations before wiring a client) | `node examples/mcp/raw-session.mjs` |
| [`mcp/`](mcp/) | Client config snippets: Claude Code, Codex, Cursor, Claude Desktop | see below |
| [`configs/`](configs/) | Ready-to-copy `.lattice/config.json` variants | see below |
| [`demo-repo/`](demo-repo/) | The broken fixture the examples copy (`add` subtracts) | — |

The SDK examples start their own daemon unless `LATTICE_URL` points at one you
already started with `lattice serve`.

## Configs

Copy one to `<project>/.lattice/config.json`, or generate one with `lattice init`.

| File | Use it when |
|---|---|
| [`ollama-qwen.json`](configs/ollama-qwen.json) | One local Qwen model via Ollama drives both proposals and decisions (what `lattice init` writes) |
| [`vllm-split-models.json`](configs/vllm-split-models.json) | A small, fast decision model and a larger generator on separate vLLM servers |
| [`hosted-openai-compatible.json`](configs/hosted-openai-compatible.json) | A hosted OpenAI-compatible API; the key comes from `$LATTICE_API_KEY`, never the file |
| [`best-of-n-parallel.json`](configs/best-of-n-parallel.json) | Deliberate best-of-N: rank 6 candidates, run the top 2 in parallel worktrees |
| [`manual-review.json`](configs/manual-review.json) | Review every decision at the TTY; the worker uses its most conservative approval mode |
| [`observe-only.json`](configs/observe-only.json) | Evidence capture only: repository snapshot + test run, no models |
| [`tessera-witness.json`](configs/tessera-witness.json) | A Tessera project: `tsr witness` (+ `tsr run` cases) is the verifier and its JSON is the evidence |
| [`random-baseline.json`](configs/random-baseline.json) | The baseline for a comparison: same generator, but decisions are a seeded uniform random pick |

Auto mode always needs `verify`: Lattice refuses to search without an objective check.

## MCP clients

`scripts/setup-agents.sh --client <claude|codex|gemini|cursor>` registers the server for you.
To do it by hand, replace `/absolute/path/to/Lattice` in:

- [`mcp/claude-code.mcp.json`](mcp/claude-code.mcp.json) → `<project>/.mcp.json`
- [`mcp/codex-config.toml`](mcp/codex-config.toml) → `~/.codex/config.toml`
- [`mcp/cursor.mcp.json`](mcp/cursor.mcp.json) → `<project>/.cursor/mcp.json`
- [`mcp/claude-desktop.json`](mcp/claude-desktop.json) → Claude Desktop config (pins the project with `-C`, since desktop apps have no project cwd)

## Going live

To run the demo against a real model instead of observe mode:

```bash
ollama pull qwen3-coder
npm install -g @qwen-code/qwen-code
examples/demo/run-demo.sh --preset ollama --keep
```
