import type { CommandSpec, CommandResult } from "@lattice/execution";
import type { EvidenceRef } from "@lattice/protocol";

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
  dependencies: string[]; // IDs of tasks that this task depends on (prerequisites)
  readScope: string[];
  writeScope: string[];
  acceptanceCriteria: string[];
  estimatedTokens?: number;
  timeoutMs: number;
  status: TaskExecutionStatus;
  error?: string;
}

export interface TaskDAG {
  id: string;
  task: string;
  nodes: Map<string, TaskNode>;
  edges: Array<{ from: string; to: string }>; // from -> to (to depends on from)
}

export interface HardwareProfile {
  maxMemoryMb?: number;
  maxMutatingWorkers?: number;
  maxReadOnlyWorkers?: number;
  isAppleSilicon?: boolean;
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

export interface SwarmExecutionOptions {
  repoRoot: string;
  task: string;
  files?: string[];
  verifyCommand?: CommandSpec;
  hardwareProfile?: HardwareProfile;
  dryRun?: boolean;
  beadsEnabled?: boolean;
  onProgress?: (event: {
    type: "task_ready" | "task_claimed" | "task_verified" | "task_failed" | "plan_evaluated";
    taskId?: string;
    beadsId?: string;
    detail?: unknown;
  }) => void;
}

export interface SwarmExecutionResult {
  dag: TaskDAG;
  evaluation: OrchBenchPlanEvaluation;
  results: Map<string, SwarmResult>;
  success: boolean;
  epicId?: string;
  summary: string;
  durationMs: number;
}
