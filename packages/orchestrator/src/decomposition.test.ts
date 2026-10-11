import test from "node:test";
import assert from "node:assert/strict";
import {
  decomposeTask,
  detectScopeCollisions,
  topologicalSort,
  calculateCriticalPath,
} from "./decomposition.js";
import type { TaskDAG, TaskNode } from "./types.js";

test("topologicalSort returns nodes in dependency order", () => {
  const nodes = new Map<string, TaskNode>();
  nodes.set("research", {
    id: "research",
    title: "Inspect codebase",
    objective: "Inspect codebase",
    role: "research",
    dependencies: [],
    readScope: ["src/"],
    writeScope: [],
    acceptanceCriteria: [],
    timeoutMs: 60_000,
    status: "pending",
  });
  nodes.set("impl", {
    id: "impl",
    title: "Implement feature",
    objective: "Implement feature",
    role: "implementation",
    dependencies: ["research"],
    readScope: ["src/"],
    writeScope: ["src/feature.ts"],
    acceptanceCriteria: [],
    timeoutMs: 60_000,
    status: "pending",
  });
  nodes.set("verify", {
    id: "verify",
    title: "Run tests",
    objective: "Run tests",
    role: "verification",
    dependencies: ["impl"],
    readScope: ["src/"],
    writeScope: [],
    acceptanceCriteria: [],
    timeoutMs: 60_000,
    status: "pending",
  });

  const dag: TaskDAG = {
    id: "test-dag-1",
    task: "Implement feature and test",
    nodes,
    edges: [
      { from: "research", to: "impl" },
      { from: "impl", to: "verify" },
    ],
  };

  const order = topologicalSort(dag);
  assert.deepEqual(order, ["research", "impl", "verify"]);
});

test("topologicalSort throws on cyclic dependencies", () => {
  const nodes = new Map<string, TaskNode>();
  nodes.set("task-a", {
    id: "task-a",
    title: "Task A",
    objective: "Task A",
    role: "implementation",
    dependencies: ["task-b"],
    readScope: [],
    writeScope: ["file-a.ts"],
    acceptanceCriteria: [],
    timeoutMs: 60_000,
    status: "pending",
  });
  nodes.set("task-b", {
    id: "task-b",
    title: "Task B",
    objective: "Task B",
    role: "implementation",
    dependencies: ["task-a"],
    readScope: [],
    writeScope: ["file-b.ts"],
    acceptanceCriteria: [],
    timeoutMs: 60_000,
    status: "pending",
  });

  const dag: TaskDAG = {
    id: "cyclic-dag",
    task: "Cyclic tasks",
    nodes,
    edges: [
      { from: "task-a", to: "task-b" },
      { from: "task-b", to: "task-a" },
    ],
  };

  assert.throws(() => topologicalSort(dag), /Cycle detected/i);
});

test("detectScopeCollisions injects dependency edge between overlapping write scopes", () => {
  const nodes = new Map<string, TaskNode>();
  nodes.set("task-1", {
    id: "task-1",
    title: "Modify shared config part 1",
    objective: "Modify shared config",
    role: "implementation",
    dependencies: [],
    readScope: [],
    writeScope: ["config.json", "src/shared.ts"],
    acceptanceCriteria: [],
    timeoutMs: 60_000,
    status: "pending",
  });
  nodes.set("task-2", {
    id: "task-2",
    title: "Modify shared config part 2",
    objective: "Modify shared config",
    role: "implementation",
    dependencies: [],
    readScope: [],
    writeScope: ["src/shared.ts", "package.json"],
    acceptanceCriteria: [],
    timeoutMs: 60_000,
    status: "pending",
  });

  const dag: TaskDAG = {
    id: "overlap-dag",
    task: "Concurrent overlapping tasks",
    nodes,
    edges: [],
  };

  // Initially task-2 has no dependencies
  assert.equal(dag.nodes.get("task-2")!.dependencies.length, 0);

  detectScopeCollisions(dag);

  // An edge should be injected to sequence task-1 and task-2
  const task2Deps = dag.nodes.get("task-2")!.dependencies;
  assert.ok(task2Deps.includes("task-1"), "task-2 must depend on task-1 due to overlapping writeScope");
  assert.ok(
    dag.edges.some((edge) => edge.from === "task-1" && edge.to === "task-2"),
    "dag.edges must record the collision-avoidance dependency"
  );
});

test("calculateCriticalPath correctly computes longest path", () => {
  const nodes = new Map<string, TaskNode>();
  nodes.set("a", {
    id: "a",
    title: "A",
    objective: "A",
    role: "research",
    dependencies: [],
    readScope: [],
    writeScope: [],
    acceptanceCriteria: [],
    timeoutMs: 10_000,
    status: "pending",
  });
  nodes.set("b1", {
    id: "b1",
    title: "B1",
    objective: "B1",
    role: "implementation",
    dependencies: ["a"],
    readScope: [],
    writeScope: ["b1.ts"],
    acceptanceCriteria: [],
    timeoutMs: 20_000,
    status: "pending",
  });
  nodes.set("b2", {
    id: "b2",
    title: "B2",
    objective: "B2",
    role: "implementation",
    dependencies: ["a"],
    readScope: [],
    writeScope: ["b2.ts"],
    acceptanceCriteria: [],
    timeoutMs: 30_000,
    status: "pending",
  });
  nodes.set("c", {
    id: "c",
    title: "C",
    objective: "C",
    role: "verification",
    dependencies: ["b1", "b2"],
    readScope: [],
    writeScope: [],
    acceptanceCriteria: [],
    timeoutMs: 15_000,
    status: "pending",
  });

  const dag: TaskDAG = {
    id: "dag-crit",
    task: "Critical path test",
    nodes,
    edges: [
      { from: "a", to: "b1" },
      { from: "a", to: "b2" },
      { from: "b1", to: "c" },
      { from: "b2", to: "c" },
    ],
  };

  const { length, path } = calculateCriticalPath(dag);
  assert.equal(length, 3); // a -> b2 -> c (or b1) has 3 steps
  assert.ok(path.includes("a") && path.includes("c"));
});

test("decomposeTask creates balanced multi-stage DAG for complex request", () => {
  const dag = decomposeTask(
    "Improve tool routing, add new coding adapters, benchmark them, and verify tests pass",
    ["packages/agents/src/index.ts", "packages/search/src/index.ts"]
  );

  assert.ok(dag.nodes.size >= 4, "Should decompose into research, implementation, and verification steps");
  const roles = Array.from(dag.nodes.values()).map((n) => n.role);
  assert.ok(roles.includes("research"));
  assert.ok(roles.includes("implementation"));
  assert.ok(roles.includes("verification"));
  assert.ok(roles.includes("integration"));

  const order = topologicalSort(dag);
  assert.equal(order.length, dag.nodes.size);
});
