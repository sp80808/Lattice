import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { buildStatsReport, type StatsReport } from "@lattice/analytics";
import { runTask } from "@lattice/core";
import { runCommand } from "@lattice/execution";
import { RandomDecisionProvider } from "@lattice/providers";
import {
  createDecisionProvider,
  describeVerify,
  verifyExecutable,
  createRunTaskOptions,
  loadLatticeConfig,
  parseLatticeConfig,
  type LatticeConfig,
  type LoadedLatticeConfig,
  type ModelEndpointConfig,
} from "@lattice/runtime";
export { describeVerify } from "@lattice/runtime";
import type { DecisionReviewer } from "@lattice/search";
import { UNKNOWN_CHOICE_ID } from "@lattice/protocol";
import type {
  DecisionRequest,
  DecisionResult,
  DoctorCheck,
  DoctorReport,
  PendingReview,
  ReviewAnswer,
  RunDetail,
  RunEvent,
  RunResult,
  RunSummary,
  TapPacket,
  TaskExecutionMode,
} from "@lattice/protocol";

export const LATTICE_VERSION = "0.0.1";

// ---------------------------------------------------------------------------
// Errors

export type ServiceErrorCode =
  | "invalid_request"
  | "not_found"
  | "config_error"
  | "conflict";

/** Error with a stable code so HTTP/MCP/CLI surfaces can map it consistently. */
export class LatticeServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LatticeServiceError";
  }
}

function invalid(message: string): never {
  throw new LatticeServiceError("invalid_request", message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Tasks

export interface ExecuteTaskOptions {
  cwd?: string;
  configPath?: string;
  mode?: TaskExecutionMode;
  reviewer?: DecisionReviewer;
  /** Observe events as they are appended to the run log. */
  onEvent?: (event: RunEvent) => void;
}

export interface ExecuteTaskResult {
  result: RunResult;
  mode: TaskExecutionMode;
  configPath?: string;
  runtimeMode: "auto" | "observe" | "evidence-only";
}

/**
 * Run a task the same way for every surface. `observe` never starts model
 * search or coding agents, even when the config asks for `mode: auto`.
 */
export async function executeTask(
  task: string,
  options: ExecuteTaskOptions = {},
): Promise<ExecuteTaskResult> {
  if (typeof task !== "string" || !task.trim()) invalid("task must be a non-empty string");
  const cwd = resolve(options.cwd ?? process.cwd());
  const mode = options.mode ?? "configured";
  if (mode !== "observe" && mode !== "configured") {
    invalid("mode must be 'observe' or 'configured'");
  }

  const loaded = await loadConfigOrThrow(cwd, options.configPath);
  if (!loaded) {
    const result = await runTask(task, { cwd, onEvent: options.onEvent });
    return { result, mode, runtimeMode: "evidence-only" };
  }

  const config: LatticeConfig =
    mode === "observe" ? { ...loaded.config, mode: "observe" } : loaded.config;

  let runOptions;
  try {
    runOptions = createRunTaskOptions(config, { reviewer: options.reviewer });
  } catch (error) {
    throw new LatticeServiceError("config_error", errorMessage(error));
  }

  const result = await runTask(task, { ...runOptions, cwd, onEvent: options.onEvent });
  return {
    result,
    mode,
    configPath: loaded.path,
    runtimeMode: config.mode ?? "auto",
  };
}

export interface StartedTask {
  runId: string;
  startedAt: string;
  /** Settles when the run ends. Failures after start are also recorded as `run.failed`. */
  done: Promise<ExecuteTaskResult>;
}

/**
 * Start a task and resolve as soon as its run is logged, without waiting for
 * it to finish. Invalid input and config errors still reject up front.
 */
export function startTask(
  task: string,
  options: ExecuteTaskOptions = {},
): Promise<StartedTask> {
  return new Promise((resolveStart, rejectStart) => {
    let started = false;
    const done = executeTask(task, {
      ...options,
      onEvent: (event) => {
        if (!started && event.type === "run.started") {
          started = true;
          resolveStart({ runId: event.runId, startedAt: event.at, done });
        }
        options.onEvent?.(event);
      },
    });
    done.then(
      () => {
        if (!started) rejectStart(new Error("run finished without a run.started event"));
      },
      (error) => {
        if (!started) rejectStart(error);
      },
    );
    // After start, failures live in the run log; keep them from becoming unhandled.
    done.catch(() => undefined);
  });
}

async function loadConfigOrThrow(
  cwd: string,
  configPath?: string,
): Promise<LoadedLatticeConfig | undefined> {
  try {
    return await loadLatticeConfig(cwd, configPath);
  } catch (error) {
    throw new LatticeServiceError("config_error", errorMessage(error));
  }
}

export async function loadConfig(
  cwd = process.cwd(),
  configPath?: string,
): Promise<LoadedLatticeConfig | undefined> {
  return loadConfigOrThrow(resolve(cwd), configPath);
}

// ---------------------------------------------------------------------------
// Remote review

export interface ReviewBrokerOptions {
  /** Unanswered reviews resolve to `stop` after this long. Default 10 minutes. */
  timeoutMs?: number;
}

interface PendingEntry {
  review: PendingReview;
  settle: (result: ReviewAnswer) => void;
}

/**
 * In-process queue that lets API/MCP clients answer supervised-mode decision
 * reviews. Pending reviews live only as long as the process that owns the run.
 */
export class ReviewBroker {
  private readonly pending = new Map<string, PendingEntry>();

  constructor(private readonly options: ReviewBrokerOptions = {}) {}

  /** A reviewer for one run. `runId` is read lazily: it is only known once the run starts. */
  reviewerFor(runId: () => string | undefined): DecisionReviewer {
    return (request) =>
      new Promise((resolveReview) => {
        const id = runId();
        if (!id || this.pending.has(id)) {
          resolveReview({ action: "stop", note: "remote review unavailable for this run" });
          return;
        }
        const timeoutMs = this.options.timeoutMs ?? 600_000;
        const now = Date.now();
        const timer = setTimeout(() => {
          this.pending.delete(id);
          resolveReview({ action: "stop", note: `no remote review within ${timeoutMs}ms` });
        }, timeoutMs);
        timer.unref?.();

        this.pending.set(id, {
          review: {
            runId: id,
            reviewId: `${request.frame.id}:r${request.round}`,
            round: request.round,
            question: request.frame.question,
            reasons: request.reasons,
            choices: request.frame.choices,
            modelSelection: request.decision.selected,
            confidence: request.decision.confidence,
            evidenceIds: request.frame.evidenceIds,
            requestedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + timeoutMs).toISOString(),
          },
          settle: (answer) => {
            clearTimeout(timer);
            this.pending.delete(id);
            const { reviewId: _reviewId, ...result } = answer;
            resolveReview(result);
          },
        });
      });
  }

  list(): PendingReview[] {
    return [...this.pending.values()]
      .map((entry) => entry.review)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  /** Find a pending review by run ID, unambiguous run-ID prefix, or `latest`. */
  get(reference: string): PendingReview {
    return this.entry(reference).review;
  }

  /** Answer a pending review; the paused run resumes immediately. */
  answer(reference: string, value: unknown): PendingReview {
    const entry = this.entry(reference);
    const answer = parseReviewAnswer(value, entry.review);
    entry.settle(answer);
    return entry.review;
  }

  private entry(reference: string): PendingEntry {
    if (reference === "latest") {
      const [latest] = this.list();
      if (latest) return this.pending.get(latest.runId)!;
      throw new LatticeServiceError("not_found", "no reviews are pending");
    }
    const matches = [...this.pending.keys()].filter((id) => id.startsWith(reference.toLowerCase()));
    if (matches.length === 0) {
      throw new LatticeServiceError("not_found", `no pending review for run ${reference}`);
    }
    if (matches.length > 1) {
      throw new LatticeServiceError("conflict", `run id prefix ${reference} is ambiguous`);
    }
    return this.pending.get(matches[0]!)!;
  }
}

export function parseReviewAnswer(value: unknown, review: PendingReview): ReviewAnswer {
  if (!isObject(value)) invalid("review answer must be an object");
  if (value.reviewId !== undefined && value.reviewId !== review.reviewId) {
    throw new LatticeServiceError(
      "conflict",
      `review ${String(value.reviewId)} is stale; the pending review is ${review.reviewId}`,
    );
  }
  if (value.note !== undefined && typeof value.note !== "string") invalid("note must be a string");
  const note = value.note as string | undefined;

  switch (value.action) {
    case "approve":
    case "refine":
    case "stop":
      return { action: value.action, note };
    case "replace": {
      // The synthetic "unknown" option is not a runnable candidate; use stop instead.
      const ids = new Set(
        review.choices.map((choice) => choice.id).filter((id) => id !== UNKNOWN_CHOICE_ID),
      );
      if (
        !Array.isArray(value.selected) ||
        value.selected.length === 0 ||
        !value.selected.every((id) => typeof id === "string" && ids.has(id))
      ) {
        invalid(`replace needs selected: a non-empty subset of ${[...ids].join(", ")}`);
      }
      return { action: "replace", selected: value.selected as string[], note };
    }
    default:
      invalid("action must be approve, replace, refine or stop");
  }
}

// ---------------------------------------------------------------------------
// Runs (read side of the append-only event log)

const RUN_ID = /^[0-9a-f][0-9a-f-]{0,35}$/i;

export function runsDirectory(cwd = process.cwd()): string {
  return join(resolve(cwd), ".lattice", "runs");
}

async function readEvents(path: string): Promise<RunEvent[]> {
  const raw = await readFile(path, "utf8");
  const events: RunEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as RunEvent);
    } catch {
      // A partially written trailing line from a live run is not fatal.
    }
  }
  return events;
}

/** Fold a run's events into a summary plus its latest TAP packet. */
export function summarizeRunEvents(
  events: RunEvent[],
  logPath: string,
): RunDetail {
  const detail: RunDetail = {
    runId: events[0]?.runId ?? "",
    status: "incomplete",
    events: events.length,
    evidence: 0,
    decisions: 0,
    experiments: 0,
    logPath,
  };

  for (const event of events) {
    const payload = isObject(event.payload) ? event.payload : {};
    switch (event.type) {
      case "run.started":
        detail.startedAt = event.at;
        if (typeof payload.task === "string") detail.task = payload.task;
        if (typeof payload.cwd === "string") detail.cwd = payload.cwd;
        break;
      case "tap.created":
      case "tap.updated":
        detail.tap = event.payload as TapPacket;
        detail.evidence = Array.isArray(detail.tap?.evidence)
          ? detail.tap.evidence.length
          : 0;
        break;
      case "decision.completed":
        if (payload.type === "decision.completed") detail.decisions++;
        break;
      case "tool.completed":
        if (payload.tool === "experiment") detail.experiments++;
        break;
      case "run.completed":
        detail.status = "completed";
        detail.endedAt = event.at;
        if (typeof payload.summary === "string") detail.summary = payload.summary;
        break;
      case "run.failed":
        detail.status = "failed";
        detail.endedAt = event.at;
        if (typeof payload.error === "string") detail.error = payload.error;
        break;
    }
  }
  return detail;
}

function stripTap(detail: RunDetail): RunSummary {
  const { tap: _tap, ...summary } = detail;
  return summary;
}

async function runFiles(cwd: string): Promise<string[]> {
  try {
    const entries = await readdir(runsDirectory(cwd));
    return entries.filter((name) => name.endsWith(".jsonl"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export interface ListRunsOptions {
  cwd?: string;
  limit?: number;
}

/** Runs in `<cwd>/.lattice/runs`, newest first. */
export async function listRuns(options: ListRunsOptions = {}): Promise<RunSummary[]> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1) invalid("limit must be a positive integer");

  const dir = runsDirectory(cwd);
  const summaries = await Promise.all(
    (await runFiles(cwd)).map(async (name) => {
      const path = join(dir, name);
      return stripTap(summarizeRunEvents(await readEvents(path), path));
    }),
  );
  return summaries
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
    .slice(0, limit);
}

/** Resolve a full run ID from `latest`, a full ID, or an unambiguous prefix. */
export async function resolveRunId(
  reference: string,
  cwd = process.cwd(),
): Promise<string> {
  if (reference === "latest") {
    const [latest] = await listRuns({ cwd, limit: 1 });
    if (!latest) throw new LatticeServiceError("not_found", "no runs recorded yet");
    return latest.runId;
  }
  if (!RUN_ID.test(reference)) invalid(`invalid run id: ${reference}`);

  const ids = (await runFiles(cwd)).map((name) => name.slice(0, -".jsonl".length));
  const matches = ids.filter((id) => id.startsWith(reference.toLowerCase()));
  if (matches.length === 0) {
    throw new LatticeServiceError("not_found", `run not found: ${reference}`);
  }
  if (matches.length > 1 && !matches.includes(reference)) {
    throw new LatticeServiceError(
      "conflict",
      `run id prefix ${reference} is ambiguous (${matches.length} matches)`,
    );
  }
  return matches.includes(reference) ? reference : matches[0]!;
}

export async function getRun(
  reference: string,
  cwd = process.cwd(),
): Promise<RunDetail> {
  const runId = await resolveRunId(reference, cwd);
  const path = join(runsDirectory(cwd), `${runId}.jsonl`);
  return summarizeRunEvents(await readEvents(path), path);
}

export async function getRunEvents(
  reference: string,
  cwd = process.cwd(),
): Promise<RunEvent[]> {
  const runId = await resolveRunId(reference, cwd);
  return readEvents(join(runsDirectory(cwd), `${runId}.jsonl`));
}

const TERMINAL_EVENTS = new Set(["run.completed", "run.failed"]);

export function isTerminalEvent(event: RunEvent): boolean {
  return TERMINAL_EVENTS.has(event.type);
}

export interface FollowOptions {
  /** Only yield events with `seq` greater than this (resume support). */
  after?: number;
  signal?: AbortSignal;
  pollMs?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    if (signal?.aborted) return resolveSleep();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolveSleep();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Tail a run's JSONL log, yielding events in order until the run completes or
 * fails (or `signal` aborts). Works for runs owned by any process.
 */
export async function* followRunEvents(
  reference: string,
  cwd = process.cwd(),
  options: FollowOptions = {},
): AsyncGenerator<RunEvent> {
  const runId = await resolveRunId(reference, cwd);
  const path = join(runsDirectory(cwd), `${runId}.jsonl`);
  const pollMs = options.pollMs ?? 200;
  let lastSeq = options.after ?? 0;
  let consumed = 0;

  while (!options.signal?.aborted) {
    const raw = await readFile(path, "utf8");
    // Only parse complete lines; a trailing partial line is read next poll.
    const end = raw.lastIndexOf("\n") + 1;
    const fresh = raw.slice(consumed, end);
    consumed = end;
    for (const line of fresh.split("\n")) {
      if (!line.trim()) continue;
      let event: RunEvent;
      try {
        event = JSON.parse(line) as RunEvent;
      } catch {
        continue;
      }
      if (event.seq <= lastSeq) continue;
      lastSeq = event.seq;
      yield event;
      if (isTerminalEvent(event) || options.signal?.aborted) return;
    }
    await sleep(pollMs, options.signal);
  }
}

export async function getStats(cwd = process.cwd()): Promise<StatsReport> {
  const root = resolve(cwd);
  return buildStatsReport([runsDirectory(root)], root);
}

// ---------------------------------------------------------------------------
// Bounded decisions

export interface DecideOptions {
  cwd?: string;
  configPath?: string;
  /** `configured` uses models.decision ?? model; `random` is the baseline. */
  provider?: "configured" | "random";
}

export function parseDecisionRequest(value: unknown): DecisionRequest {
  if (!isObject(value)) invalid("decision request must be an object");
  if (typeof value.question !== "string" || !value.question.trim()) {
    invalid("question must be a non-empty string");
  }
  if (!Array.isArray(value.choices) || value.choices.length === 0) {
    invalid("choices must be a non-empty array");
  }
  const ids = new Set<string>();
  const choices = value.choices.map((choice, index) => {
    if (
      !isObject(choice) ||
      typeof choice.id !== "string" ||
      !choice.id.trim() ||
      typeof choice.label !== "string"
    ) {
      invalid(`choices[${index}] must have a non-empty string id and a string label`);
    }
    if (ids.has(choice.id)) invalid(`duplicate choice id: ${choice.id}`);
    ids.add(choice.id);
    return {
      id: choice.id,
      label: choice.label,
      detail: typeof choice.detail === "string" ? choice.detail : undefined,
    };
  });
  const mode = value.mode;
  if (
    mode !== undefined &&
    mode !== "choice" &&
    mode !== "rank" &&
    mode !== "boolean" &&
    mode !== "score"
  ) {
    invalid("mode must be one of choice, rank, boolean, score");
  }
  return {
    question: value.question,
    choices,
    state: typeof value.state === "string" ? value.state : undefined,
    mode,
    allowUnknown:
      typeof value.allowUnknown === "boolean" ? value.allowUnknown : undefined,
  };
}

export async function decide(
  request: DecisionRequest,
  options: DecideOptions = {},
): Promise<DecisionResult> {
  const provider = options.provider ?? "configured";
  if (provider === "random") return new RandomDecisionProvider().decide(request);
  if (provider !== "configured") invalid("provider must be 'configured' or 'random'");

  const loaded = await loadConfigOrThrow(resolve(options.cwd ?? process.cwd()), options.configPath);
  let decider;
  try {
    decider = loaded ? createDecisionProvider(loaded.config) : undefined;
  } catch (error) {
    throw new LatticeServiceError("config_error", errorMessage(error));
  }
  if (!decider) {
    throw new LatticeServiceError(
      "config_error",
      "no decision model configured (set model or models.decision, or use provider=random)",
    );
  }
  return decider.decide(request);
}

// ---------------------------------------------------------------------------
// Doctor

export interface FindExecutableOptions {
  platform?: NodeJS.Platform;
  /** Windows executable extensions; defaults to $PATHEXT. */
  pathExt?: string;
}

/**
 * Find an executable on PATH (or verify an explicit path). On Windows a bare
 * name is also tried with each $PATHEXT extension (`qwen` → `qwen.cmd`).
 */
export async function findExecutable(
  command: string,
  pathEnv = process.env.PATH ?? "",
  options: FindExecutableOptions = {},
): Promise<string | undefined> {
  const windows = (options.platform ?? process.platform) === "win32";
  const separator = windows ? ";" : delimiter;
  const explicit = command.includes("/") || (windows && command.includes("\\"));
  const extensions =
    windows && !extname(command)
      ? ["", ...(options.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
      : [""];

  const bases = explicit
    ? [resolve(command)]
    : pathEnv
        .split(separator)
        .filter(Boolean)
        .map((dir) => join(dir, command));
  for (const base of bases) {
    for (const extension of extensions) {
      const candidate = base + extension;
      try {
        // On Windows X_OK degrades to an existence check, which is the intent there.
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}

export interface DoctorOptions {
  cwd?: string;
  configPath?: string;
  /** Probe model endpoints over the network (default true). */
  network?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const AGENT_INSTALL_HINTS: Record<string, string> = {
  "qwen-code": "npm install -g @qwen-code/qwen-code",
  opencode: "see https://opencode.ai for install options",
};

async function probeModel(
  role: string,
  model: ModelEndpointConfig,
  options: Required<Pick<DoctorOptions, "timeoutMs">> & { fetchImpl: typeof fetch },
): Promise<DoctorCheck> {
  const id = `model.${role}`;
  const url = model.baseUrl.replace(/\/+$/, "") + "/models";
  const headers: Record<string, string> = {};
  const key = model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined;
  if (key) headers.authorization = `Bearer ${key}`;

  try {
    const response = await options.fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      return {
        id,
        status: "fail",
        message: `${url} returned HTTP ${response.status}`,
        hint: response.status === 401 ? "check the API key environment variable" : undefined,
      };
    }
    const body = (await response.json().catch(() => undefined)) as
      | { data?: Array<{ id?: unknown }> }
      | undefined;
    const ids = Array.isArray(body?.data)
      ? body.data.map((item) => item.id).filter((v): v is string => typeof v === "string")
      : undefined;
    if (ids && !ids.some((name) => name === model.model || name.startsWith(`${model.model}:`))) {
      return {
        id,
        status: "warn",
        message: `${model.baseUrl} is reachable but does not list model ${model.model}`,
        hint: `available: ${ids.slice(0, 8).join(", ") || "none"}; for Ollama run: ollama pull ${model.model}`,
      };
    }
    return { id, status: "ok", message: `${model.model} @ ${model.baseUrl}` };
  } catch (error) {
    return {
      id,
      status: "fail",
      message: `cannot reach ${url}: ${errorMessage(error)}`,
      hint: "start the model server (e.g. `ollama serve`) or fix baseUrl",
    };
  }
}

/** Environment and configuration health checks. Never throws for bad config. */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const checks: DoctorCheck[] = [];
  const network = options.network ?? true;
  const probe = {
    timeoutMs: options.timeoutMs ?? 3_000,
    fetchImpl: options.fetchImpl ?? fetch,
  };

  const major = Number(process.versions.node.split(".")[0]);
  checks.push(
    major >= 22
      ? { id: "node", status: "ok", message: `node ${process.versions.node}` }
      : { id: "node", status: "fail", message: `node ${process.versions.node}`, hint: "Lattice requires Node.js >= 22" },
  );

  const git = await runCommand({ command: "git", args: ["rev-parse", "--show-toplevel"], cwd, timeoutMs: 5_000 }).catch(
    () => undefined,
  );
  if (!git) {
    checks.push({ id: "git", status: "fail", message: "git not found", hint: "install git; worktree isolation depends on it" });
  } else if (git.exitCode === 0) {
    checks.push({ id: "git", status: "ok", message: `repository ${git.stdout.trim()}` });
  } else {
    checks.push({
      id: "git",
      status: "warn",
      message: "not inside a git repository",
      hint: "auto mode needs git worktrees; run `git init` and commit first",
    });
  }

  let loaded: LoadedLatticeConfig | undefined;
  try {
    loaded = await loadLatticeConfig(cwd, options.configPath);
  } catch (error) {
    checks.push({ id: "config", status: "fail", message: errorMessage(error), hint: "fix the file or run `lattice init --force`" });
    return { ok: false, cwd, checks };
  }

  if (!loaded) {
    checks.push({
      id: "config",
      status: "warn",
      message: "no config found; runs are evidence-only",
      hint: "run `lattice init` to create .lattice/config.json",
    });
    return { ok: !checks.some((c) => c.status === "fail"), cwd, checks };
  }

  const config = loaded.config;
  const mode = config.mode ?? "auto";
  checks.push({ id: "config", status: "ok", message: `${loaded.path} (mode=${mode})` });

  if (mode === "auto") {
    try {
      createRunTaskOptions(config);
      checks.push({ id: "config.auto", status: "ok", message: "model, agent and verifier are configured" });
    } catch (error) {
      checks.push({ id: "config.auto", status: "fail", message: errorMessage(error) });
    }
  }

  const decisionModel = config.models?.decision ?? config.model;
  if (decisionModel?.provider === "random") {
    checks.push({
      id: "model.decision",
      status: "ok",
      message: `random baseline${decisionModel.seed === undefined ? "" : ` (seed ${decisionModel.seed})`}`,
    });
  }
  const models: Array<[string, ModelEndpointConfig | undefined]> = [
    ["decision", decisionModel?.provider === "random" ? undefined : decisionModel],
    ["generator", config.models?.generator ?? config.model],
  ];
  const seen = new Set<string>();
  for (const [role, model] of models) {
    if (!model) continue;
    const key = `${model.baseUrl}\0${model.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = models[0]![1] === models[1]![1] ? "default" : role;

    if (model.apiKeyEnv && !process.env[model.apiKeyEnv]) {
      checks.push({
        id: `model.${label}.apiKey`,
        status: "fail",
        message: `${model.apiKeyEnv} is not set`,
        hint: `export ${model.apiKeyEnv}=...`,
      });
    }
    checks.push(
      network
        ? await probeModel(label, model, probe)
        : { id: `model.${label}`, status: "skip", message: `${model.model} @ ${model.baseUrl} (network checks disabled)` },
    );
  }

  if (config.agent) {
    const command = config.agent.command ?? (config.agent.preset === "qwen-code" ? "qwen" : "opencode");
    const found = await findExecutable(command);
    checks.push(
      found
        ? { id: "agent", status: "ok", message: `${config.agent.preset}: ${found}` }
        : {
            id: "agent",
            status: mode === "auto" ? "fail" : "warn",
            message: `${config.agent.preset} command \`${command}\` not found on PATH`,
            hint: AGENT_INSTALL_HINTS[config.agent.preset],
          },
    );
  }

  if (config.verify) {
    const executable = verifyExecutable(config.verify);
    const found = await findExecutable(executable);
    checks.push(
      found
        ? { id: "verify", status: "ok", message: describeVerify(config.verify) }
        : { id: "verify", status: "fail", message: `verifier \`${executable}\` not found on PATH` },
    );
  }

  return {
    ok: !checks.some((c) => c.status === "fail"),
    cwd,
    configPath: loaded.path,
    checks,
  };
}

// ---------------------------------------------------------------------------
// Init

export type InitPreset = "ollama" | "vllm" | "openai-compatible" | "observe";

export const INIT_PRESETS: readonly InitPreset[] = [
  "ollama",
  "vllm",
  "openai-compatible",
  "observe",
];

const PRESET_DEFAULTS: Record<Exclude<InitPreset, "observe">, { baseUrl?: string; model?: string }> = {
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3-coder" },
  vllm: { baseUrl: "http://127.0.0.1:8000/v1" },
  "openai-compatible": {},
};

export interface VerifyCommand {
  command: string;
  args: string[];
}

export interface InitOptions {
  preset?: InitPreset;
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  agent?: "qwen-code" | "opencode";
  verify?: VerifyCommand;
  autonomy?: "autopilot" | "supervised" | "manual";
}

export interface InitPlan {
  config: LatticeConfig;
  warnings: string[];
}

/**
 * Build a validated config. Without a verifier the config falls back to
 * `observe`, because auto mode refuses to search without objective checks.
 */
export function buildInitConfig(options: InitOptions = {}): InitPlan {
  const preset = options.preset ?? "ollama";
  if (!INIT_PRESETS.includes(preset)) {
    invalid(`preset must be one of ${INIT_PRESETS.join(", ")}`);
  }
  const warnings: string[] = [];
  const verify = options.verify
    ? { command: options.verify.command, args: options.verify.args, timeoutMs: 120_000 }
    : undefined;

  if (preset === "observe") {
    return {
      config: parseLatticeConfig({ mode: "observe", ...(verify ? { verify } : {}) }),
      warnings: verify ? warnings : ["no verifier detected; pass --verify to record test evidence"],
    };
  }

  const defaults = PRESET_DEFAULTS[preset];
  const baseUrl = options.baseUrl ?? defaults.baseUrl;
  const model = options.model ?? defaults.model;
  if (!baseUrl) invalid(`preset ${preset} requires a base URL`);
  if (!model) invalid(`preset ${preset} requires a model name`);

  const apiKeyEnv =
    options.apiKeyEnv ?? (preset === "openai-compatible" ? "LATTICE_API_KEY" : undefined);
  const agent = options.agent ?? "qwen-code";

  let mode: "auto" | "observe" = "auto";
  if (!verify) {
    mode = "observe";
    warnings.push(
      "no verifier detected; wrote mode=observe. Add --verify \"<cmd>\" and re-run init to enable auto search",
    );
  }

  const config = parseLatticeConfig({
    mode,
    autonomy: { mode: options.autonomy ?? "supervised" },
    model: {
      provider: "openai-compatible",
      baseUrl,
      model,
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
    },
    agent:
      agent === "qwen-code"
        ? { preset: "qwen-code", approvalMode: "auto-edit", outputFormat: "json" }
        : { preset: "opencode", format: "json" },
    ...(verify ? { verify } : {}),
    search: { maxRounds: 4, candidatesPerRound: 4 },
  });
  return { config, warnings };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Split a simple command line on whitespace. No shell parsing or quoting. */
export function parseCommandLine(value: string): VerifyCommand {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) invalid("verify command must not be empty");
  return { command: parts[0]!, args: parts.slice(1) };
}

/** Best-effort guess of the project's test command from well-known manifests. */
export async function detectVerifyCommand(cwd = process.cwd()): Promise<VerifyCommand | undefined> {
  const root = resolve(cwd);
  const pkgPath = join(root, "package.json");
  if (await exists(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      const test = pkg.scripts?.test;
      if (test && !/no test specified/.test(test)) return { command: "npm", args: ["test"] };
    } catch {
      // unreadable package.json: fall through to other manifests
    }
  }
  if (await exists(join(root, "Cargo.toml"))) return { command: "cargo", args: ["test"] };
  if (await exists(join(root, "go.mod"))) return { command: "go", args: ["test", "./..."] };
  for (const marker of ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"]) {
    if (await exists(join(root, marker))) return { command: "python3", args: ["-m", "pytest"] };
  }
  const makefile = join(root, "Makefile");
  if (await exists(makefile) && /^test\s*:/m.test(await readFile(makefile, "utf8"))) {
    return { command: "make", args: ["test"] };
  }
  return undefined;
}

export interface WriteConfigOptions {
  cwd?: string;
  path?: string;
  force?: boolean;
}

/** Write `.lattice/config.json` (and a runs/ gitignore); refuses to overwrite without force. */
export async function writeConfig(
  config: LatticeConfig,
  options: WriteConfigOptions = {},
): Promise<string> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const path = options.path
    ? isAbsolute(options.path) ? options.path : resolve(cwd, options.path)
    : join(cwd, ".lattice", "config.json");

  if (!options.force && (await exists(path))) {
    throw new LatticeServiceError("conflict", `${path} already exists (use --force to overwrite)`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");

  const ignore = join(cwd, ".lattice", ".gitignore");
  if (!options.path && !(await exists(ignore))) {
    await writeFile(ignore, "# run logs are local evidence; config.json is meant to be shared\nruns/\n", "utf8");
  }
  return path;
}
