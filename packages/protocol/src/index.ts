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

/**
 * One run of a structured verifier (e.g. `tsr witness`). `record` is the
 * tool's own machine-readable output, stored verbatim in the run log so the
 * verdict can be replayed without re-running or scraping terminal text.
 */
export interface VerificationRecord {
  tool: string;
  /** True only when the tool itself reported success. Never a model opinion. */
  passed: boolean;
  summary: string;
  evidence: EvidenceRef[];
  record: unknown;
}

/** A verifier that produces structured evidence instead of a bare exit code. */
export interface Verifier {
  readonly tool: string;
  /** What will run, for the event log (command, file, flags). */
  describe(): Record<string, unknown>;
  verify(cwd: string): Promise<VerificationRecord>;
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
  /** Present when the run used the search loop. */
  search?: {
    status: "solved" | "blocked" | "budget_exhausted";
    rounds: number;
    selected: string[];
  };
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
  /** `false` returns 202 + runId as soon as the run starts (default `true`). */
  wait?: boolean;
  /**
   * `remote` parks supervised/manual review requests for an API/MCP client to
   * answer (see /v1/reviews). Default `none`: such decisions block the run.
   */
  review?: "none" | "remote";
}

/** Response to `POST /v1/tasks` with `wait: false`. */
export interface TaskAccepted {
  runId: string;
  status: "running";
  startedAt: string;
  mode: TaskExecutionMode;
  links: { run: string; events: string };
}

export type RunStatus = "completed" | "failed" | "incomplete";

/**
 * Held by the process executing a run, renewed by heartbeat and removed when
 * the run ends. Lets readers tell a live run from one whose process died.
 */
export interface RunLease {
  schema: "lattice.run-lease/v1";
  runId: string;
  pid: number;
  host: string;
  acquiredAt: string;
  heartbeatAt: string;
  /** The lease is stale once `heartbeatAt + ttlMs` has passed. */
  ttlMs: number;
}

/**
 * Liveness of an `incomplete` run: `running` while its lease is fresh,
 * `interrupted` once the holder is gone (dead pid on this host, or an expired
 * lease), `unknown` for runs logged before leases existed.
 */
export type RunLiveness = "running" | "interrupted" | "unknown";

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
  /** Set for `incomplete` runs; see {@link RunLiveness}. */
  liveness?: RunLiveness;
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

/** A supervised/manual-mode decision waiting for a remote reviewer. */
export interface PendingReview {
  runId: string;
  /** Changes every round; pass it back to guard against answering a stale review. */
  reviewId: string;
  round: number;
  question: string;
  reasons: string[];
  choices: DecisionChoice[];
  /** What the decision model picked. */
  modelSelection: string[];
  confidence?: number;
  evidenceIds: string[];
  requestedAt: string;
  expiresAt: string;
}

export type ReviewAnswer =
  | { action: "approve"; note?: string; reviewId?: string }
  | { action: "replace"; selected: string[]; note?: string; reviewId?: string }
  | { action: "refine"; note?: string; reviewId?: string }
  | { action: "stop"; note?: string; reviewId?: string };
