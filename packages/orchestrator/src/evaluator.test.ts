import test from "node:test";
import assert from "node:assert/strict";
import { evaluateOrchestrationPlan } from "./evaluator.js";
import type { TaskDAG, TaskNode } from "./types.js";

test("evaluateOrchestrationPlan recommends single agent for linear single-file plan", () => {
  const nodes = new Map<string, TaskNode>();
  nodes.set("research", {
    id: "research",
    title: "Inspect single file",
    objective: "Inspect",
    role: "research",
    dependencies: [],
    readScope: ["src/index.ts"],
    writeScope: [],
    acceptanceCriteria: [],
    timeoutMs: 60_000,
    status: "pending",
  });
  nodes.set("impl", {
    id: "impl",
    title: "Fix bug in single file",
    objective: "Fix bug",
    role: "implementation",
    dependencies: ["research"],
    readScope: ["src/index.ts"],
    writeScope: ["src/index.ts"],
    acceptanceCriteria: [],
    timeoutMs: 60_000,
    status: "pending",
  });
  nodes.set("verify", {
    id: "verify",
    title: "Run tests",
    objective: "Verify",
    role: "verification",
    dependencies: ["impl"],
    readScope: ["src/index.ts"],
    writeScope: [],
    acceptanceCriteria: [],
    timeoutMs: 60_000,
    status: "pending",
  });

  const dag: TaskDAG = {
    id: "dag-linear",
    task: "Fix a single typo in src/index.ts",
    nodes,
    edges: [
      { from: "research", to: "impl" },
      { from: "impl", to: "verify" },
    ],
  };

  const evaluation = evaluateOrchestrationPlan(dag);
  assert.equal(evaluation.isParallelBeneficial, false, "Single file linear tasks should NOT swarm");
  assert.equal(evaluation.recommendedWorkerCount, 1);
  assert.ok(evaluation.reason.toLowerCase().includes("single agent"), "Reason must state single agent preference");
});

test("evaluateOrchestrationPlan recommends swarming for independent subtasks", () => {
  const nodes = new Map<string, TaskNode>();
  nodes.set("research", {
    id: "research",
    title: "Inspect repo",
    objective: "Inspect",
    role: "research",
    dependencies: [],
    readScope: ["packages/"],
    writeScope: [],
    acceptanceCriteria: [],
    timeoutMs: 60_000,
    status: "pending",
  });
  nodes.set("impl-1", {
    id: "impl-1",
    title: "Implement component A",
    objective: "Implement A",
    role: "implementation",
    dependencies: ["research"],
    readScope: ["packages/core"],
    writeScope: ["packages/core/src/a.ts"],
    acceptanceCriteria: [],
    timeoutMs: 60_000,
    status: "pending",
  });
  nodes.set("impl-2", {
    id: "impl-2",
    title: "Implement component B",
    objective: "Implement B",
    role: "implementation",
    dependencies: ["research"],
    readScope: ["packages/search"],
    writeScope: ["packages/search/src/b.ts"],
    acceptanceCriteria: [],
    timeoutMs: 60_000,
    status: "pending",
  });
  nodes.set("verify", {
    id: "verify",
    title: "Verify tests",
    objective: "Verify",
    role: "verification",
    dependencies: ["impl-1", "impl-2"],
    readScope: [],
    writeScope: [],
    acceptanceCriteria: [],
    timeoutMs: 60_000,
    status: "pending",
  });

  const dag: TaskDAG = {
    id: "dag-parallel",
    task: "Implement independent components across core and search",
    nodes,
    edges: [
      { from: "research", to: "impl-1" },
      { from: "research", to: "impl-2" },
      { from: "impl-1", to: "verify" },
      { from: "impl-2", to: "verify" },
    ],
  };

  const evaluation = evaluateOrchestrationPlan(dag);
  assert.equal(evaluation.isParallelBeneficial, true, "Independent components should allow parallel execution");
  assert.ok(evaluation.recommendedWorkerCount >= 2, "Recommended workers should be at least 2");
  assert.equal(evaluation.dependencyWidth, 2);
});

test("evaluateOrchestrationPlan honors Apple Silicon hardware profile limits", () => {
  const nodes = new Map<string, TaskNode>();
  for (let i = 1; i <= 6; i++) {
    nodes.set(`task-${i}`, {
      id: `task-${i}`,
      title: `Task ${i}`,
      objective: `Task ${i}`,
      role: "implementation",
      dependencies: [],
      readScope: [],
      writeScope: [`file-${i}.ts`],
      acceptanceCriteria: [],
      timeoutMs: 60_000,
      status: "pending",
    });
  }

  const dag: TaskDAG = {
    id: "dag-wide",
    task: "6 parallel tasks",
    nodes,
    edges: [],
  };

  const m1Profile = {
    maxMemoryMb: 16_384,
    maxMutatingWorkers: 1,
    maxReadOnlyWorkers: 2,
    isAppleSilicon: true,
  };

  const evaluation = evaluateOrchestrationPlan(dag, m1Profile);
  // Concurrency for mutating workers must be capped at 1 on M1 profile
  assert.equal(evaluation.recommendedWorkerCount, 1, "Must respect maxMutatingWorkers=1 on shared tree");
});
