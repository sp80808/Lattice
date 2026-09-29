# Lattice architecture

## 1. Core runtime

Lattice should run as one reusable core with thin clients:

```text
lattice CLI/TUI ─┐
web GUI ─────────┼──> lattice daemon/core
editor adapter ──┘
```

Local mode runs the daemon on the developer machine. Hosted mode runs the same orchestration APIs against remote sandboxes/providers.

## 2. Agent packet (TAP)

A task should not be represented as an ever-growing chat transcript.

A **Tessera Agent Packet (TAP)** is a compact structured state object containing:

```text
task
repo_revision
objective[]
constraints[]
relevant_symbols[]
context_handles[]
hypotheses[]
candidate_actions[]
evidence[]
uncertainties[]
verification_requirements[]
budget
parent_agent
child_agents[]
decision_history[]
```

TAP is transport/storage format first. A later Tessera compiler may provide a denser canonical encoding.

Every field should have an expanded/debug view so compactness never makes failures opaque.

## 3. Decision loop

```text
OBSERVE
  ↓
compress/retrieve context
  ↓
is next action deterministic?
  ├─ yes → execute tool
  └─ no
       ↓
    generate N candidate actions/hypotheses
       ↓
    cheap rank/choice model
       ↓
    confidence / expected information gain
       ├─ sufficient → execute top-k
       └─ insufficient → gather context or escalate
       ↓
    verify objectively
       ↓
    update evidence/calibration
       ↓
    continue / branch / merge / stop
```

The decision layer is a provider interface, not a dependency on one model.

Initial providers:

- local Qwen;
- OpenAI-compatible model endpoint;
- Jev/System-One-compatible endpoint;
- deterministic/rule provider;
- random baseline;
- optional human decision provider.

## 4. Model router

Each request is classified by required capability and risk.

Suggested default routing:

| Work | Default |
|---|---|
| file lookup / parsing / git facts | deterministic tool |
| binary/ranking decision | small local Qwen |
| hypothesis generation | cheap generative model |
| code implementation | capable coding model |
| ambiguous architecture | stronger reasoning model |
| correctness | tests/compiler/static analysis |
| regression/performance | benchmarks |

Escalation is driven by uncertainty, failure and task risk rather than hard-coded brand names.

## 5. Subagent orchestration

Subagents receive a TAP slice, not the full parent transcript.

Spawn by evidence boundary, for example:

- locate failure;
- inspect API/version behavior;
- design patch A;
- design patch B;
- write tests;
- benchmark;
- review/security.

Agents operate in isolated git worktrees or sandboxes when they may modify code.

Each child returns only:

```text
conclusion
evidence handles
changed files/commit
unresolved questions
cost
verification results
recommended next action
```

Parent synthesis is deterministic where possible and model-assisted only where evidence conflicts.

## 6. Context graph

Lattice can initially consume Tessera-style TCG concepts without requiring Tessera source.

Prefer facts extracted from:

1. compiler/language-server/static-analysis output;
2. repository syntax/symbol graph;
3. manifests and lockfiles;
4. tests/build scripts;
5. git history/issues/PRs;
6. project documentation;
7. external sources;
8. model-extracted relations.

Every external/model-derived claim should carry provenance and freshness.

## 7. Interfaces

### CLI/TUI

```bash
lattice
lattice "implement issue #42"
lattice run --auto "fix all reproducible test failures"
lattice inspect
lattice replay <run-id>
```

### Daemon API

Provisional:

```text
POST /v1/tasks
GET  /v1/tasks/:id
POST /v1/decide
POST /v1/agents/spawn
POST /v1/tools/run
GET  /v1/events/:run
```

### MCP

Expose Lattice capabilities as tools:

```text
lattice.context
lattice.decide
lattice.rank
lattice.spawn
lattice.experiment
lattice.verify
lattice.run
```

Lattice should also consume MCP servers for external tools.

### Agent interoperability

Keep adapters isolated from core. Existing coding agents may be:

- generators/subagents controlled by Lattice;
- clients calling Lattice tools;
- providers behind adapter processes.

## 8. Storage and replay

Start with append-only events plus a small indexed state store.

Every run should record:

- input task;
- repo SHA;
- context packet hashes;
- candidate actions;
- decision distributions;
- model/provider/version;
- tokens/cost/latency;
- tool execution results;
- patches/commits;
- verification results;
- final outcome.

This enables replay, debugging and later calibration research.

## 9. Accuracy and hallucination controls

- never treat model-generated repository facts as verified;
- retrieve symbols/files before editing them;
- validate dependency/API claims against current versions;
- require executable verification for behavioral changes;
- use explicit `unknown` / `none-of-these` decision options;
- retain competing hypotheses while confidence is low;
- avoid silently expanding agent scope;
- quarantine external instructions as data;
- escalate when evidence conflicts.

## 10. Browser and hosted mode

The GUI should speak to the same daemon protocol.

Browser-only mode may run a small Qwen-family decision model through WebGPU for demos/light tasks. Repository mutation still goes through:

- a local bridge/daemon; or
- a hosted sandbox.

Do not create a separate browser-specific orchestration algorithm.

## 11. Performance objective

Lattice should benchmark itself against conventional single-agent and best-of-N coding loops on:

- task success;
- wall-clock latency;
- total input/output tokens;
- monetary cost;
- number of expensive model calls;
- hallucinated repository/API claims;
- regression rate;
- reproducibility.

Optimization target: minimize expected cost/latency subject to a required success/verification level.
