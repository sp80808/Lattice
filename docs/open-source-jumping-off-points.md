# Open-source jumping-off points

Lattice should reuse proven architectural boundaries from mature open-source coding agents while keeping its novel work concentrated in compact state, cheap discrimination, evidence-driven search and orchestration.

This document is an architectural reference map, not permission to copy implementation code. Check each upstream project's license and preserve attribution/licensing obligations before reusing code.

## OpenCode — client/server boundary and shared UI backend

Repository: https://github.com/anomalyco/opencode

Useful precedent:

- terminal UI and programmable CLI are clients of the same backend;
- local server/API enables web and other clients without duplicating agent logic;
- current TUI extraction keeps UI behind an SDK boundary rather than importing backend internals.

Lattice adoption:

- one daemon/core for CLI, TUI, web and editor integrations;
- clients consume a stable protocol;
- no orchestration algorithm implemented only in the GUI.

Do not copy OpenCode's full session model. Lattice's run/TAP/event model is deliberately smaller and evidence-first.

## Qwen Code — subagents and multi-provider coding-agent UX

Repository: https://github.com/QwenLM/qwen-code

Useful precedent:

- specialized subagents have separate context and controlled tools;
- external Codex/Claude-style agents can be delegated to through adapters;
- multiple provider protocols and local runtimes can sit behind one user experience.

Lattice adoption:

- child agents receive a compact TAP slice rather than parent chat history;
- capability-based agent adapters;
- Qwen-family models are the first target for cheap bounded decisions, not hard-coded as the only generator.

## Aider — repository maps and architect/editor separation

Repository: https://github.com/Aider-AI/aider

Useful precedent:

- concise repository maps provide key files, symbols, types and signatures instead of dumping the whole repository;
- architect/editor mode separates higher-level solution design from concrete edits.

Lattice adoption:

- TCG retrieval should produce a token-budgeted repo map / connected subgraph;
- separate hypothesis/proposal generation from implementation;
- route proposal ranking to cheaper decision models before paying for edits.

Lattice should extend repo maps with evidence, provenance, freshness and observed failure/fix relationships.

## goose — MCP, provider portability and isolated delegation

Repository: https://github.com/aaif-goose/goose

Useful precedent:

- CLI, desktop and embeddable API surfaces;
- broad model-provider support;
- MCP as the extension/tool boundary;
- delegated subagents use isolated sessions rather than automatically inheriting the full parent conversation.

Lattice adoption:

- consume and expose MCP;
- isolate child context;
- keep provider interfaces independent from orchestration policy.

## OpenHands Agent SDK — local and ephemeral workspaces

Repository: https://github.com/All-Hands-AI/OpenHands

Useful precedent:

- coding agents can run against local workspaces or remote/ephemeral workspaces;
- agent functionality can be embedded behind SDK/server interfaces.

Lattice adoption:

- workspace is an adapter: local repository, git worktree, container or hosted sandbox;
- orchestration should not assume local filesystem execution.

## Agent Client Protocol (ACP) — coding-agent interoperability

Organization/spec: https://github.com/agentclientprotocol
Codex adapter: https://github.com/agentclientprotocol/codex-acp

Useful precedent:

- standard agent/editor transport;
- permissions, tool events, plans, terminal output, edits and child sessions can cross the protocol boundary;
- existing agents can be exposed to compatible clients through adapters.

Lattice adoption:

- prefer ACP for editor/client-facing agent interoperability;
- MCP remains the agent-to-tool integration surface;
- provide a Lattice ACP agent and/or consume ACP child agents once the core run protocol stabilizes.

## tree-sitter / SCIP — deterministic repository structure

Repositories:
- https://github.com/tree-sitter/tree-sitter
- https://github.com/sourcegraph/scip

Useful precedent:

- incremental syntax structure;
- language-agnostic semantic indexing interchange.

Lattice adoption:

- compiler/LSP/static facts should populate TCG before LLM extraction;
- use adapter interfaces so richer language-specific indexes can replace fallback parsing.

## Initial build-vs-borrow rule

Prefer an upstream/open standard when the feature is commodity infrastructure:

**Borrow/integrate**
- terminal rendering;
- ACP/MCP protocol libraries;
- model-provider clients;
- local model runtimes;
- parsers/indexers;
- sandbox/container primitives;
- git/worktree mechanics.

**Build in Lattice**
- TAP compact agent-state protocol;
- token-budgeted TCG packet selection;
- question compiler;
- Qwen/Jev-like bounded decision layer;
- uncertainty/cost-aware router;
- generate → decide → experiment → verify search policy;
- evidence ledger and outcome calibration;
- cross-agent synthesis based on verified evidence.

## Prototype dependency direction

The first prototype should remain intentionally light:

```text
Node 22 + TypeScript
  ├─ zero-dependency core task/event model
  ├─ git/shell adapters
  ├─ provider adapters
  ├─ MCP/ACP adapters
  └─ UI clients
```

Add larger frameworks only when they eliminate real implementation work or improve compatibility. The orchestration thesis should remain testable independently of any one upstream harness.
