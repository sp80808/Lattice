import type { TaskDAG, TaskNode, TaskRole } from "./types.js";

/**
 * Topologically sorts task nodes in a DAG. Throws an error if cycles are detected.
 */
export function topologicalSort(dag: TaskDAG): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const id of dag.nodes.keys()) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }

  for (const edge of dag.edges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    adj.get(edge.from)?.push(edge.to);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    order.push(curr);

    for (const neighbor of adj.get(curr) ?? []) {
      const nextDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, nextDeg);
      if (nextDeg === 0) queue.push(neighbor);
    }
  }

  if (order.length !== dag.nodes.size) {
    throw new Error("Cycle detected in TaskDAG dependencies");
  }

  return order;
}

/**
 * Scans DAG for tasks with overlapping write scopes and sequences them with a dependency edge
 * to prevent concurrent file mutation collisions.
 */
export function detectScopeCollisions(dag: TaskDAG): void {
  const nodeList = Array.from(dag.nodes.values());

  for (let i = 0; i < nodeList.length; i++) {
    for (let j = i + 1; j < nodeList.length; j++) {
      const nodeA = nodeList[i]!;
      const nodeB = nodeList[j]!;

      // Check if write scopes overlap
      const hasOverlap = nodeA.writeScope.some((fileA) =>
        nodeB.writeScope.some((fileB) => fileA === fileB || fileA.startsWith(fileB) || fileB.startsWith(fileA)),
      );

      if (hasOverlap) {
        // If nodeB does not already depend on nodeA and nodeA does not depend on nodeB
        const bDependsOnA = nodeB.dependencies.includes(nodeA.id);
        const aDependsOnB = nodeA.dependencies.includes(nodeB.id);

        if (!bDependsOnA && !aDependsOnB) {
          nodeB.dependencies.push(nodeA.id);
          dag.edges.push({ from: nodeA.id, to: nodeB.id });
        }
      }
    }
  }
}

/**
 * Calculates the critical path length and node sequence through the DAG.
 */
export function calculateCriticalPath(dag: TaskDAG): { length: number; path: string[] } {
  const order = topologicalSort(dag);
  const dist = new Map<string, number>();
  const prev = new Map<string, string | undefined>();

  for (const id of dag.nodes.keys()) {
    dist.set(id, 1);
    prev.set(id, undefined);
  }

  for (const u of order) {
    const uDist = dist.get(u) ?? 1;
    for (const edge of dag.edges.filter((e) => e.from === u)) {
      const v = edge.to;
      const vDist = dist.get(v) ?? 1;
      if (uDist + 1 > vDist) {
        dist.set(v, uDist + 1);
        prev.set(v, u);
      }
    }
  }

  let maxLen = 0;
  let endNode: string | undefined;
  for (const [id, d] of dist.entries()) {
    if (d > maxLen) {
      maxLen = d;
      endNode = id;
    }
  }

  const path: string[] = [];
  let curr = endNode;
  while (curr) {
    path.unshift(curr);
    curr = prev.get(curr);
  }

  return { length: maxLen, path };
}

/**
 * Decomposes a multi-stage software engineering task into a structured TaskDAG.
 */
export function decomposeTask(task: string, files: string[] = []): TaskDAG {
  const nodes = new Map<string, TaskNode>();
  const edges: Array<{ from: string; to: string }> = [];

  // Stage 1: Research
  nodes.set("research", {
    id: "research",
    title: "Inspect codebase and locate target symbols",
    objective: `Examine context and dependencies for task: ${task}`,
    role: "research",
    dependencies: [],
    readScope: files.length > 0 ? files : ["src/"],
    writeScope: [],
    acceptanceCriteria: ["Identify responsible modules and integration points"],
    timeoutMs: 60_000,
    status: "pending",
  });

  // Stage 2: Implementation
  const implNodeIds: string[] = [];
  if (files.length > 1) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const implId = `impl-${i + 1}`;
      nodes.set(implId, {
        id: implId,
        title: `Implement changes in ${file}`,
        objective: `Implement logic in ${file} for: ${task}`,
        role: "implementation",
        dependencies: ["research"],
        readScope: files,
        writeScope: [file],
        acceptanceCriteria: [`Complete code edits in ${file}`],
        timeoutMs: 120_000,
        status: "pending",
      });
      edges.push({ from: "research", to: implId });
      implNodeIds.push(implId);
    }
  } else {
    nodes.set("implementation", {
      id: "implementation",
      title: "Implement required modifications in isolated worktree",
      objective: `Implement core logic for: ${task}`,
      role: "implementation",
      dependencies: ["research"],
      readScope: files,
      writeScope: files.length > 0 ? files : ["src/"],
      acceptanceCriteria: ["Complete minimal code edits"],
      timeoutMs: 120_000,
      status: "pending",
    });
    edges.push({ from: "research", to: "implementation" });
    implNodeIds.push("implementation");
  }

  // Stage 3: Verification
  nodes.set("verification", {
    id: "verification",
    title: "Run deterministic tests and verification suite",
    objective: "Verify tests pass without regressions",
    role: "verification",
    dependencies: implNodeIds,
    readScope: files,
    writeScope: [],
    acceptanceCriteria: ["All test oracles and compiler checks exit with 0"],
    timeoutMs: 90_000,
    status: "pending",
  });
  for (const implId of implNodeIds) {
    edges.push({ from: implId, to: "verification" });
  }

  // Stage 4: Integration
  nodes.set("integration", {
    id: "integration",
    title: "Final review and merge changeset",
    objective: "Inspect diff and promote verified branch commit",
    role: "integration",
    dependencies: ["verification"],
    readScope: files,
    writeScope: [],
    acceptanceCriteria: ["Verification evidence attached to reviewable TAP packet"],
    timeoutMs: 60_000,
    status: "pending",
  });
  edges.push({ from: "verification", to: "integration" });

  return {
    id: `dag-${Date.now()}`,
    task,
    nodes,
    edges,
  };
}
