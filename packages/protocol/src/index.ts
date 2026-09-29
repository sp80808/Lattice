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


export const UNKNOWN_CHOICE_ID = "__none__" as const;

export type DecisionMode = "choice" | "rank" | "boolean" | "score";

export interface DecisionChoice {
  id: string;
  label: string;
  detail?: string;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  latencyMs: number;
}

export interface ProviderIdentity {
  provider: string;
  model?: string;
}

export interface DecisionRequest {
  state?: string;
  question: string;
  choices: DecisionChoice[];
  mode?: DecisionMode;
  allowUnknown?: boolean;
}

export interface DecisionResult {
  selected: string[];
  scores: Record<string, number>;
  confidence?: number;
  entropy?: number;
  identity: ProviderIdentity;
  usage: ProviderUsage;
}

export interface GeneratorRequest {
  system?: string;
  prompt: string;
  context?: string[];
  temperature?: number;
}

export interface GeneratorResult {
  text: string;
  identity: ProviderIdentity;
  usage: ProviderUsage;
}

export interface DecisionProvider {
  decide(request: DecisionRequest): Promise<DecisionResult>;
}

export interface GeneratorProvider {
  generate(request: GeneratorRequest): Promise<GeneratorResult>;
}
