export const TAP_VERSION = "0.1" as const;

export type EvidenceKind =
  | "repository"
  | "command"
  | "test"
  | "build"
  | "lint"
  | "benchmark"
  | "model"
  | "external";

export interface EvidenceRef {
  id: string;
  kind: EvidenceKind;
  verified: boolean;
  source: string;
  summary: string;
  createdAt: string;
}

export interface Budget {
  maxRounds?: number;
  maxTokens?: number;
  maxCostUsd?: number;
}

export interface TapPacket {
  version: typeof TAP_VERSION;
  runId: string;
  task: string;
  repo?: {
    root: string;
    revision?: string;
  };
  objectives: string[];
  constraints: string[];
  context: string[];
  hypotheses: string[];
  candidateActions: string[];
  evidence: EvidenceRef[];
  uncertainties: string[];
  verification: string[];
  budget: Budget;
  parentRunId?: string;
  childRunIds: string[];
}

export type RunEventType =
  | "run.started"
  | "tap.created"
  | "decision.requested"
  | "decision.completed"
  | "tool.started"
  | "tool.completed"
  | "run.completed"
  | "run.failed";

export interface RunEvent<T = unknown> {
  seq: number;
  runId: string;
  at: string;
  type: RunEventType;
  payload: T;
}

export interface RunResult {
  runId: string;
  status: "completed" | "failed";
  summary: string;
  tap: TapPacket;
  eventLogPath: string;
}
