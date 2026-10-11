# Adaptive Multi-Agent Swarm & Beads-Native Orchestration Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an evidence-grounded, hardware-aware multi-agent orchestration layer (`@lattice/orchestrator`) utilizing Beads (`bd`) for distributed task ownership, OrchBench plan evaluation, and semantic integration verification without spinning up divergent git worktrees.

**Architecture:** A dedicated `@lattice/orchestrator` package decomposes complex requests into a versioned `TaskDAG` with write-scope collision detection. It evaluates concurrency benefits using OrchBench heuristics (critical path vs coordination cost), registers tasks and dependencies in Beads (`bd`), coordinates specialist roles across the shared working tree with atomic claims, and enforces whole-system semantic integration tests (*Passes Alone, Fails Together*).

**Tech Stack:** TypeScript, Node.js (`node:child_process`, `node:crypto`, `node:fs/promises`), `@lattice/protocol`, `@lattice/execution`, `@lattice/agents`, Beads CLI (`bd`).

**Spec:** `docs/superpowers/specs/2026-10-10-adaptive-swarm-orchestrator-design.md`

## Global Constraints
- Target package: `packages/orchestrator` with bindings in `@lattice/core` and `apps/cli`.
- Single-branch coordination: No parallel git worktree proliferation. Use Beads (`bd`) for task tracking, dependencies, and atomic claims.
- Concurrency ceiling: Max 1 mutating worker + lightweight read-only workers (Apple Silicon M1 Pro 16GB limit).
- Default to single agent: Swarming activates only when dependency width > 1 and predicted speedup outweighs coordination cost.
- Semantic integration verification: All integrated patches must pass full test suite before parent epic completion.

---

### Task 1: Scaffolding `@lattice/orchestrator` & Typed Protocols

**Files:**
- Create: `packages/orchestrator/package.json`
- Create: `packages/orchestrator/tsconfig.json`
- Create: `packages/orchestrator/src/types.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes: `@lattice/protocol` (`TapPacket`, `EvidenceRef`), `@lattice/execution` (`CommandSpec`, `runCommand`)
- Produces: `TaskRole`, `TaskExecutionStatus`, `TaskNode`, `TaskDAG`, `OrchBenchPlanEvaluation`, `SwarmTask`, `SwarmResult`

- [ ] **Step 1: Create package.json and tsconfig.json for @lattice/orchestrator**
- [ ] **Step 2: Define types in packages/orchestrator/src/types.ts**
- [ ] **Step 3: Update pnpm-workspace.yaml and tsconfig.json references**
- [ ] **Step 4: Verify build with `pnpm --filter @lattice/orchestrator build`**
- [ ] **Step 5: Commit scaffolding**

---

### Task 2: Task Graph Decomposition & Scope Collision Detector

**Files:**
- Create: `packages/orchestrator/src/decomposition.ts`
- Test: `packages/orchestrator/src/decomposition.test.ts`

**Interfaces:**
- Consumes: `TaskDAG`, `TaskNode`, `TaskRole` from `types.ts`
- Produces: `decomposeTask(intent: string, files?: string[]): TaskDAG`, `detectScopeCollisions(dag: TaskDAG): void`

- [ ] **Step 1: Write tests in `decomposition.test.ts` for DAG construction, cycle detection, and scope collision detection**
- [ ] **Step 2: Run test to verify it fails (`node --test packages/orchestrator/dist/decomposition.test.js`)**
- [ ] **Step 3: Implement `decomposition.ts` with topological sorting, cycle detection, and automatic prerequisite edge injection for overlapping write scopes**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit task decomposition module**

---

### Task 3: OrchBench Plan Evaluator & Concurrency Gate

**Files:**
- Create: `packages/orchestrator/src/evaluator.ts`
- Test: `packages/orchestrator/src/evaluator.test.ts`

**Interfaces:**
- Consumes: `TaskDAG`, `OrchBenchPlanEvaluation` from `types.ts`
- Produces: `evaluateOrchestrationPlan(dag: TaskDAG, hardwareProfile?: HardwareProfile): OrchBenchPlanEvaluation`

- [ ] **Step 1: Write tests in `evaluator.test.ts` for critical-path calculation, speedup estimation, and single-agent gating**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement `evaluator.ts` with critical path calculation, token estimation, and M1 Pro memory limits**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit plan evaluator module**

---

### Task 4: Beads Coordinator (`BeadsCoordinator`)

**Files:**
- Create: `packages/orchestrator/src/beads.ts`
- Test: `packages/orchestrator/src/beads.test.ts`

**Interfaces:**
- Consumes: `TaskDAG`, `TaskNode` from `types.ts`, `runCommand` from `@lattice/execution`
- Produces: `BeadsCoordinator` class with `createEpic`, `syncTaskDag`, `claimTask`, `queryReady`, `completeTask`

- [ ] **Step 1: Write tests in `beads.test.ts` with mock command executor testing issue creation, dependency linking, and claim lifecycle**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement `beads.ts` executing `bd create`, `bd dep add`, `bd update --claim`, `bd ready`, and `bd close`**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit Beads coordinator module**

---

### Task 5: Swarm Scheduler & Semantic Integration Verifier

**Files:**
- Create: `packages/orchestrator/src/scheduler.ts`
- Create: `packages/orchestrator/src/index.ts`
- Test: `packages/orchestrator/src/scheduler.test.ts`

**Interfaces:**
- Consumes: `BeadsCoordinator`, `TaskDAG`, `evaluateOrchestrationPlan`, `AgentAdapter` from `@lattice/agents`
- Produces: `runAdaptiveSwarm(options: SwarmExecutionOptions): Promise<SwarmExecutionResult>`

- [ ] **Step 1: Write tests in `scheduler.test.ts` testing ready-task dispatch, fault isolation, and semantic integration regression check**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement `scheduler.ts` with worker pool, leaf verification, and post-integration test suite verification**
- [ ] **Step 4: Export public API in `packages/orchestrator/src/index.ts`**
- [ ] **Step 5: Run tests to verify they pass**
- [ ] **Step 6: Commit scheduler and orchestrator entrypoint**

---

### Task 6: CLI & Core Integration and End-to-End Test Suite

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `apps/cli/src/commands.ts`
- Modify: `packages/core/package.json`
- Modify: `apps/cli/package.json`
- Test: `packages/core/src/index.test.ts`

**Interfaces:**
- Consumes: `runAdaptiveSwarm` from `@lattice/orchestrator`
- Produces: `runTask(..., { swarm: SwarmOptions })`, `lattice swarm "<task>"` CLI command

- [ ] **Step 1: Write integration test in `packages/core/src/index.test.ts` verifying adaptive swarm orchestration**
- [ ] **Step 2: Wire `@lattice/orchestrator` into `@lattice/core` and `apps/cli`**
- [ ] **Step 3: Run full repository test suite (`pnpm test`)**
- [ ] **Step 4: Commit CLI and core integration**
