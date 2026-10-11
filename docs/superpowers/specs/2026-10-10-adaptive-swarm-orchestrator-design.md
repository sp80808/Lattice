# Specification: Adaptive Multi-Agent Swarm & Beads-Native Orchestration Engine

**Date:** 2026-10-10  
**Status:** Approved for Implementation  
**Target:** `@lattice/orchestrator`, `@lattice/core`, `@lattice/agents`, `@lattice/protocol`, `@lattice/runtime`, `apps/cli`  
**Primary References:**  
- *AsynCodeBench* (arXiv:2609.32662, Sept 2026): Asynchronous cross-agent dependency satisfaction; explicit dependency graphs and checkers; tracking satisfied states.
- *OrchBench* (arXiv:2607.25656, July 2026): Evaluate orchestration plans prior to expensive execution; critical path, task dependencies, context transfer, predicted speedup; default to simple/single-agent plans.
- *OrchestraBench* (arXiv:2608.05263, Aug 2026): Failure propagation, recovery, and fault decomposition; distinguishing infrastructure, ambiguity, and semantic mistakes; avoiding blind retries.
- *Passes Alone, Fails Together* (SPLASH/ISSTA EXPRESS 2026, Oct 2026): Semantic integration conflicts across independently passing patches; requiring full integrated acceptance checks.
- *VERSE* (arXiv:2610.02616, Oct 2026): Verification-backed optimization; recording execution graphs and telemetry to improve orchestration policies from empirical evidence.

---

## 1. Executive Summary & Architectural Motivation

Multi-agent swarming often fails in practice due to two fatal flaws:
1. **Unbounded Spawning & Worktree Divergence:** Spawning speculative parallel git worktrees creates messy, long-winded branch reconciliation when multiple coding agents (e.g. Lattice, OpenCode, Codex) run simultaneously in the repository.
2. **Semantic Integration Regressions:** Patches developed in isolation that pass their local unit tests frequently break the system when merged together (*Passes Alone, Fails Together*).

Lattice's solution is **Adaptive Swarming Grounded in Beads**:
- **Beads (`bd`) as Distributed Orchestration Substrate:** Uses Beads issues, dependencies (`bd dep add`), acceptance criteria (`--acceptance`), atomic claims (`bd update <id> --claim`), and ready-queue scheduling (`bd ready`) across all co-existing agents on the shared tree.
- **OrchBench Pre-Execution Gate:** Simulates task decomposition first. Evaluates critical path, dependency width, file ownership overlap, and resource limits before launching workers. Defaults to a single agent for simple or tightly coupled edits.
- **Hardware-Aware Bounds (Apple Silicon M1 Pro 16GB):** Limits concurrency to at most 1 active mutating code worker plus lightweight read-only workers, avoiding memory thrashing and context bloating.
- **Typed TAP Communication:** Subtasks receive minimal TAP slices (`SwarmTask`) and return evidence-backed results (`SwarmResult`), never multi-megabyte chat transcripts.
- **Two-Phase Semantic Integration Verification:** Enforces whole-system integration and regression testing before closing Beads epics.

---

## 2. Core Architecture: `@lattice/orchestrator`

The orchestrator lives in a new monorepo package `packages/orchestrator` (with exports in `@lattice/core` and CLI commands).

### 2.1 Component Overview

```text
User Natural-Language Task
           │
           ▼
┌────────────────────────────────────────────────────────┐
│  Adaptive Task Decomposer (Grounded in Repo Facts)     │
│  - Extracts subtasks, read/write scopes, deliverables   │
│  - Injects dependency edges on write-scope collisions   │
└──────────────────────────┬─────────────────────────────┘
                           │ TaskDAG
                           ▼
┌────────────────────────────────────────────────────────┐
│  OrchBench Plan Evaluator & Concurrency Gate           │
│  - Critical-path length vs dependency width            │
│  - Predicted speedup vs coordination overhead          │
│  - Single-Agent Decision: swarm only if speedup > cost │
└──────────────────────────┬─────────────────────────────┘
                           │ Approved Plan
                           ▼
┌────────────────────────────────────────────────────────┐
│  Beads Issue & Dependency Registrar (`bd`)             │
│  - Creates parent epic & child tasks with acceptance   │
│  - Registers dependency DAG via `bd dep add`           │
└──────────────────────────┬─────────────────────────────┘
                           │
       ┌───────────────────┴───────────────────┐
       ▼                                       ▼
┌─────────────────────────┐         ┌─────────────────────────┐
│ Concurrent Read-Only    │         │ Serialized Mutating     │
│ Specialists             │         │ Specialist Worker       │
│ - Research / Context    │         │ - Atomic Claim (bd)     │
│ - Test / Verification   │         │ - Bounded file writes   │
│ - Code Review / Audit   │         │ - Objective leaf verif  │
└──────────────┬──────────┘         └───────────┬─────────────┘
               │                                │
               └───────────────┬────────────────┘
                               ▼
┌────────────────────────────────────────────────────────┐
│  Semantic Integration Verifier                         │
│  - Passes Alone, Fails Together cross-component check  │
│  - Executes full integration test suite                │
│  - Close Beads tasks (`bd close <id> --suggest-next`)  │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
               Evidence Ledger & VERSE Replay
```

---

## 3. Data Structures & Typed Interfaces

### 3.1 Task Graph & Plan Evaluation

```typescript
export type TaskRole =
  | "coordinator"
  | "research"
  | "implementation"
  | "verification"
  | "review"
  | "integration"
  | "performance";

export type TaskExecutionStatus =
  | "pending"
  | "ready"
  | "claimed"
  | "in_progress"
  | "verified"
  | "failed"
  | "blocked"
  | "skipped";

export interface TaskNode {
  id: string;
  beadsId?: string;
  parentId?: string;
  title: string;
  objective: string;
  role: TaskRole;
  dependencies: string[]; // ids of task nodes that must complete first
  readScope: string[];
  writeScope: string[];
  acceptanceCriteria: string[];
  estimatedTokens?: number;
  timeoutMs: number;
  status: TaskExecutionStatus;
}

export interface TaskDAG {
  id: string;
  task: string;
  nodes: Map<string, TaskNode>;
  edges: Array<{ from: string; to: string }>; // from -> to (to depends on from)
}

export interface OrchBenchPlanEvaluation {
  dagId: string;
  totalNodes: number;
  dependencyWidth: number;
  criticalPathLength: number;
  isParallelBeneficial: boolean;
  recommendedWorkerCount: number;
  reason: string;
  estimatedTotalTokens: number;
  estimatedWallClockMs: number;
}
```

### 3.2 Typed TAP Communication

```typescript
export interface SwarmTask {
  id: string;
  beadsId?: string;
  parentId?: string;
  baseRevision: string;
  objective: string;
  role: TaskRole;
  acceptanceCriteria: string[];
  dependencies: string[];
  readScope: string[];
  writeScope: string[];
  contextHandles: string[];
  allowedCapabilities: string[];
  budget: {
    tokens?: number;
    costUsd?: number;
    timeoutMs: number;
  };
}

export interface SwarmResult {
  taskId: string;
  beadsId?: string;
  status:
    | "verified"
    | "failed"
    | "inconclusive"
    | "unsupported"
    | "tool_error"
    | "cancelled";
  evidenceIds: string[];
  changedFiles: string[];
  unresolvedDependencies: string[];
  verificationResults: string[];
  tokensUsed?: number;
  durationMs: number;
  error?: string;
}
```

---

## 4. Beads-Native Coordination & Scheduling

### 4.1 CLI & Dolt Interaction Layer (`BeadsCoordinator`)

- **Issue Creation:**
  ```bash
  bd create --title="[Lattice Swarm] <subtask>" --description="..." --type=task --priority=2 --acceptance="..." --parent=<epic-id>
  ```
- **Dependency Linking:**
  ```bash
  bd dep add <child-beads-id> <prerequisite-beads-id>
  ```
- **Atomic Work Claim:**
  ```bash
  bd update <beads-id> --claim
  ```
- **Ready Work Query:**
  ```bash
  bd ready
  ```
- **Closing & Handoff:**
  ```bash
  bd close <beads-id> --suggest-next
  ```

### 4.2 Concurrency & Mutex Management
- Mutating tasks acquire atomic execution claims in the shared tree.
- When write scopes overlap, the DAG compiler injects a prerequisite dependency edge, forcing sequential order.
- Non-mutating tasks (research, review, verification) execute concurrently without lock contention.

---

## 5. Semantic Integration Verification (Passes Alone, Fails Together)

1. **Leaf Verification:** Each implementation task must satisfy its assigned unit tests / typechecks before reporting `verified`.
2. **Cross-Component Semantic Verification:** Once all subtasks in a phase or DAG are complete:
   - Run combined compilation and static analysis (`tsc -b`).
   - Run full integration test suite (`pnpm test` or configured verify command).
   - If semantic integration fails, the parent epic is marked `failed` or decomposed into a conflict-resolution subtask rather than blindly closing.

---

## 6. Testing & Validation Strategy

1. **Unit Tests (`packages/orchestrator/src/index.test.ts`):**
   - DAG cycle detection, topological sorting, and critical-path calculation.
   - OrchBench plan evaluation: correctly selects single-agent for single-file/tightly-coupled changes, enables swarming for independent subtasks.
   - Write-scope collision detector: verifies dependency edge injection when files overlap.
   - Mock Beads adapter testing: issue creation, dependency linking, claims, and status transitions.
2. **Integration Tests (`packages/core/src/index.test.ts`):**
   - End-to-end task execution with adaptive swarm mode.
   - Failure isolation: child worker failure does not destroy sibling evidence.
   - Semantic conflict detection: catches cross-task interface incompatibilities.
