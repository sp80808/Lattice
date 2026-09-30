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
  | "tap.updated"
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

// ---------------------------------------------------------------------------
// Daemon / SDK / MCP wire types. Shared so clients need no runtime deps.

/**
 * How a submitted task uses the project's Lattice config.
 * - `observe`: load config but only gather evidence (incl. the configured verifier).
 * - `configured`: honour the config as written; `mode: auto` runs model search + coding agents.
 */
export type TaskExecutionMode = "observe" | "configured";

export interface TaskSubmission {
  task: string;
  cwd?: string;
  mode?: TaskExecutionMode;
  configPath?: string;
}

export type RunStatus = "completed" | "failed" | "incomplete";

export interface RunSummary {
  runId: string;
  status: RunStatus;
  task?: string;
  cwd?: string;
  summary?: string;
  error?: string;
  startedAt?: string;
  endedAt?: string;
  events: number;
  evidence: number;
  decisions: number;
  experiments: number;
  logPath: string;
}

export interface RunDetail extends RunSummary {
  tap?: TapPacket;
}

export type DoctorStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  message: string;
  hint?: string;
}

export interface DoctorReport {
  ok: boolean;
  cwd: string;
  configPath?: string;
  checks: DoctorCheck[];
}

export interface ApiErrorBody {
  error: string;
  code: string;
}
