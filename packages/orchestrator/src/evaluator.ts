import { calculateCriticalPath, topologicalSort } from "./decomposition.js";
import type {
  HardwareProfile,
  OrchBenchPlanEvaluation,
  TaskDAG,
  TaskNode,
} from "./types.js";

/**
 * Calculates the maximum width of concurrent tasks at any topological stage.
 */
export function calculateDependencyWidth(dag: TaskDAG): number {
  if (dag.nodes.size <= 1) return dag.nodes.size;

  // Compute depth (distance from root) for each node
  const depths = new Map<string, number>();
  const sorted = topologicalSort(dag);

  for (const id of sorted) {
    const node = dag.nodes.get(id);
    if (!node || node.dependencies.length === 0) {
      depths.set(id, 0);
    } else {
      let maxParentDepth = 0;
      for (const depId of node.dependencies) {
        maxParentDepth = Math.max(maxParentDepth, depths.get(depId) ?? 0);
      }
      depths.set(id, maxParentDepth + 1);
    }
  }

  // Count nodes at each depth
  const depthCounts = new Map<number, number>();
  for (const depth of depths.values()) {
    depthCounts.set(depth, (depthCounts.get(depth) ?? 0) + 1);
  }

  let maxWidth = 1;
  for (const count of depthCounts.values()) {
    if (count > maxWidth) maxWidth = count;
  }

  return maxWidth;
}

/**
 * Default Apple Silicon M1 Pro profile (16 GB unified memory).
 */
export const DEFAULT_M1_PROFILE: HardwareProfile = {
  maxMemoryMb: 16_384,
  maxMutatingWorkers: 2,
  maxReadOnlyWorkers: 3,
  isAppleSilicon: true,
};

/**
 * Evaluates an orchestration plan before expensive execution (OrchBench pattern).
 * Determines if multi-agent swarming is genuinely beneficial or if a single agent is preferred.
 */
export function evaluateOrchestrationPlan(
  dag: TaskDAG,
  hardwareProfile: HardwareProfile = DEFAULT_M1_PROFILE
): OrchBenchPlanEvaluation {
  const totalNodes = dag.nodes.size;
  const { length: criticalPathLength } = calculateCriticalPath(dag);
  const dependencyWidth = calculateDependencyWidth(dag);

  // Estimate token usage per role
  let estimatedTotalTokens = 0;
  let estimatedWallClockMs = 0;

  for (const node of dag.nodes.values()) {
    switch (node.role) {
      case "research":
        estimatedTotalTokens += 1_200;
        estimatedWallClockMs += 25_000;
        break;
      case "implementation":
        estimatedTotalTokens += 3_500;
        estimatedWallClockMs += 60_000;
        break;
      case "verification":
        estimatedTotalTokens += 800;
        estimatedWallClockMs += 20_000;
        break;
      case "review":
        estimatedTotalTokens += 1_500;
        estimatedWallClockMs += 30_000;
        break;
      case "integration":
        estimatedTotalTokens += 1_000;
        estimatedWallClockMs += 40_000;
        break;
      default:
        estimatedTotalTokens += 1_000;
        estimatedWallClockMs += 30_000;
    }
  }

  // Check mutating node count
  const mutatingNodes = Array.from(dag.nodes.values()).filter(
    (n) => n.role === "implementation"
  );
  const hasMultipleMutations = mutatingNodes.length > 1;

  // Decide if parallelism is beneficial
  let isParallelBeneficial = false;
  let recommendedWorkerCount = 1;
  let reason = "Single agent is sufficient for sequential, tightly-coupled, or small tasks.";

  if (dependencyWidth > 1 && (totalNodes > 3 || hasMultipleMutations)) {
    // If there are independent branches
    isParallelBeneficial = true;
    const maxMutating = hardwareProfile.maxMutatingWorkers ?? 1;
    const maxReadOnly = hardwareProfile.maxReadOnlyWorkers ?? 2;

    // If mutating on the shared tree without separate worktrees, limit mutating worker concurrency
    recommendedWorkerCount = Math.min(
      dependencyWidth,
      hasMultipleMutations ? maxMutating : maxReadOnly
    );

    reason = `Multi-agent swarming is beneficial: dependency width=${dependencyWidth}, critical path=${criticalPathLength}. Allocated ${recommendedWorkerCount} worker(s) within hardware constraints.`;
  } else {
    reason = `Single agent preferred: dependency width=${dependencyWidth} and critical path length=${criticalPathLength} indicate no measurable concurrency speedup.`;
  }

  return {
    dagId: dag.id,
    totalNodes,
    dependencyWidth,
    criticalPathLength,
    isParallelBeneficial,
    recommendedWorkerCount,
    reason,
    estimatedTotalTokens,
    estimatedWallClockMs,
  };
}
