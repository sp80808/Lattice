/**
 * Benchmark harness for Lattice's search loop (GH #9).
 *
 * A suite is a directory of tasks, each a small repository with a bug, a
 * verifier command and a fixed set of candidate actions (some of which apply
 * a scripted patch). The generator and executor are deterministic stand-ins,
 * so the ONLY variable between runs is the decision strategy. That measures
 * Lattice's orchestration (does choosing well reach a verified fix in fewer
 * rounds and verifier runs than choosing badly?), not model quality. Plug a
 * real decision model in with the `configured` strategy to measure that.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { runTask } from "@lattice/core";
import { runCommand, type CommandSpec, type CommandResult } from "@lattice/execution";
import {
  UNKNOWN_CHOICE_ID,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResult,
  type GeneratorProvider,
  type ProviderUsage,
} from "@lattice/protocol";
import { RandomDecisionProvider } from "@lattice/providers";
import { createDecisionProvider, loadLatticeConfig } from "@lattice/runtime";
import type { CandidateAction, ExperimentExecutor, ExperimentOutcome } from "@lattice/search";
import { access } from "node:fs/promises";
import { constants } from "node:fs";

export const BENCH_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Suite format

export interface PatchSpec {
  file: string;
  find: string;
  replace: string;
}

export interface BenchCandidate {
  id: string;
  label: string;
  action: string;
  expectedEvidence: string;
  estimatedCost?: "low" | "medium" | "high";
  /** Scripted edit applied when this candidate runs. Reverted if verification fails. */
  patch?: PatchSpec;
  /** Marks the candidate whose patch makes the verifier pass (the oracle's pick). */
  solves?: boolean;
}

export interface BenchVerify {
  /** `{NODE}` and `{TSR}` are replaced with resolved binaries. */
  command: string;
  args?: string[];
  timeoutMs?: number;
  /** When set, exit 0 is not enough: trimmed stdout must equal this. */
  expectStdout?: string;
}

export type TaskDifficulty = "easy" | "medium" | "hard";

/** Optional task metadata, following Terminal-Bench's category/difficulty annotations. */
export interface TaskMetadata {
  /** Free-form domain tag, e.g. "software", "languages". Purely descriptive. */
  category?: string;
  difficulty?: TaskDifficulty;
}

export interface BenchTaskSpec {
  id: string;
  description?: string;
  task: string;
  /** External tools this task needs, e.g. ["tsr"]. The task is skipped if one is unavailable. */
  requires?: string[];
  verify: BenchVerify;
  candidates: BenchCandidate[];
  metadata?: TaskMetadata;
}

export interface BenchTask extends BenchTaskSpec {
  dir: string;
  repoDir: string;
}

export interface BenchSuite {
  name: string;
  dir: string;
  tasks: BenchTask[];
  /** sha256 over every task spec and fixture file, for comparing runs across commits. */
  digest: string;
}

const IGNORED = (name: string) => name.startsWith("._") || name === ".DS_Store";

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => !IGNORED(entry.name))
      .map((entry) =>
        entry.isDirectory()
          ? listFiles(join(dir, entry.name), base)
          : Promise.resolve([relative(base, join(dir, entry.name))]),
      ),
  );
  return nested.flat().sort();
}

function validateSpec(spec: unknown, path: string): BenchTaskSpec {
  const fail = (message: string): never => {
    throw new Error(`${path}: ${message}`);
  };
  if (!spec || typeof spec !== "object") return fail("task.json must be an object");
  const value = spec as Partial<BenchTaskSpec>;
  if (typeof value.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.id)) fail("id must be kebab-case");
  if (typeof value.task !== "string" || !value.task.trim()) fail("task must be a non-empty string");
  if (!value.verify || typeof value.verify.command !== "string") fail("verify.command is required");
  if (!Array.isArray(value.candidates) || value.candidates.length < 2) fail("need at least 2 candidates");

  const ids = new Set<string>();
  let solvers = 0;
  for (const candidate of value.candidates!) {
    if (!candidate.id || candidate.id === UNKNOWN_CHOICE_ID || ids.has(candidate.id)) {
      fail(`invalid or duplicate candidate id: ${candidate.id}`);
    }
    ids.add(candidate.id);
    for (const key of ["label", "action", "expectedEvidence"] as const) {
      if (typeof candidate[key] !== "string" || !candidate[key]) fail(`candidate ${candidate.id}: ${key} is required`);
    }
    if (candidate.solves) {
      solvers++;
      if (!candidate.patch) fail(`candidate ${candidate.id}: solves requires a patch`);
    }
  }
  if (solvers !== 1) fail(`exactly one candidate must set solves (found ${solvers})`);

  if (value.metadata !== undefined) {
    const metadata = value.metadata;
    if (metadata.category !== undefined && (typeof metadata.category !== "string" || !metadata.category.trim())) {
      fail("metadata.category must be a non-empty string");
    }
    if (
      metadata.difficulty !== undefined &&
      metadata.difficulty !== "easy" &&
      metadata.difficulty !== "medium" &&
      metadata.difficulty !== "hard"
    ) {
      fail("metadata.difficulty must be 'easy', 'medium', or 'hard'");
    }
  }
  return value as BenchTaskSpec;
}

export async function loadSuite(suiteDir: string): Promise<BenchSuite> {
  const dir = resolve(suiteDir);
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`suite directory not found: ${dir}`);
    throw error;
  });
  const taskDirs = entries
    .filter((entry) => entry.isDirectory() && !IGNORED(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort();

  const tasks: BenchTask[] = [];
  const hash = createHash("sha256");
  for (const taskDir of taskDirs) {
    const specPath = join(taskDir, "task.json");
    const raw = await readFile(specPath, "utf8").catch(() => undefined);
    if (raw === undefined) continue;
    const spec = validateSpec(JSON.parse(raw), specPath);
    const repoDir = join(taskDir, "repo");
    if (!(await stat(repoDir).catch(() => undefined))?.isDirectory()) {
      throw new Error(`${taskDir}: missing repo/ directory`);
    }
    tasks.push({ ...spec, dir: taskDir, repoDir });

    hash.update(`task\0${spec.id}\0${raw}\0`);
    for (const file of await listFiles(repoDir)) {
      hash.update(`${file}\0`);
      hash.update(await readFile(join(repoDir, file)));
      hash.update("\0");
    }
  }
  if (tasks.length === 0) throw new Error(`${dir}: no tasks found (expected <task>/task.json)`);
  const ids = tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${dir}: duplicate task ids`);
  return { name: dir.split("/").pop() ?? "suite", dir, tasks, digest: hash.digest("hex") };
}

// ---------------------------------------------------------------------------
// External tools

export interface ToolPaths {
  tsr?: string;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Find `tsr`: $TSR_BIN, a sibling ../Tessera checkout's build output, then PATH. */
export async function resolveTools(root = process.cwd(), env = process.env): Promise<ToolPaths> {
  const candidates = [
    env.TSR_BIN,
    join(root, "..", "Tessera", "target", "debug", "tsr"),
    join(root, "..", "Tessera", "target", "release", "tsr"),
    ...(env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "tsr")),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (await executable(candidate)) return { tsr: resolve(candidate) };
  }
  return {};
}

function missingTools(task: BenchTask, tools: ToolPaths): string[] {
  return (task.requires ?? []).filter((name) => !(tools as Record<string, string | undefined>)[name]);
}

function expand(value: string, tools: ToolPaths): string {
  return value.replaceAll("{NODE}", process.execPath).replaceAll("{TSR}", tools.tsr ?? "tsr-not-found");
}

function verifySpec(task: BenchTask, cwd: string, tools: ToolPaths): CommandSpec {
  return {
    command: expand(task.verify.command, tools),
    args: (task.verify.args ?? []).map((arg) => expand(arg, tools)),
    cwd,
    timeoutMs: task.verify.timeoutMs ?? 60_000,
  };
}

async function passes(task: BenchTask, cwd: string, tools: ToolPaths) {
  const spec = verifySpec(task, cwd, tools);
  let result: CommandResult;
  try {
    result = await runCommand(spec);
  } catch (error) {
    // A missing verifier binary is a task/environment failure, not a suite crash:
    // Terminal-Bench found "executable not installed / not in PATH" is the most
    // common single command failure, so it must be measurable, not fatal.
    result = {
      command: spec.command,
      args: spec.args ?? [],
      cwd: spec.cwd ?? cwd,
      exitCode: 127,
      signal: null,
      stdout: "",
      stderr: String(error),
      durationMs: 0,
      timedOut: false,
      outputTruncated: false,
    };
  }
  const ok =
    result.exitCode === 0 &&
    !result.timedOut &&
    (task.verify.expectStdout === undefined || result.stdout.trim() === task.verify.expectStdout.trim());
  return { ok, result };
}

// ---------------------------------------------------------------------------
// Strategies

export type StrategyName = "first" | "random" | "cheapest-first" | "oracle" | "configured";

export const OFFLINE_STRATEGIES: readonly StrategyName[] = ["first", "random", "cheapest-first", "oracle"];

const COST_RANK = { low: 0, medium: 1, high: 2 } as const;

/** 32-bit avalanche hash (murmur3 finalizer) so consecutive seeds start far apart. */
function mix32(value: number): number {
  let x = (value + 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * Small deterministic PRNG (mulberry32). The seed is hashed first: raw mulberry32
 * gives visibly correlated first draws for seeds 1, 2, 3, ..., which skewed a
 * benchmark that uses exactly those seeds.
 */
export function seededRandom(seed: number): () => number {
  let state = mix32(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(request: DecisionRequest, selectedId: string, name: string): DecisionResult {
  const ids = request.choices.map((choice) => choice.id).filter((id) => id !== UNKNOWN_CHOICE_ID);
  const scores = Object.fromEntries(ids.map((id) => [id, id === selectedId ? 0.7 : 0.3 / Math.max(1, ids.length - 1)]));
  return {
    selected: [selectedId],
    scores,
    confidence: scores[selectedId],
    identity: { provider: name },
    usage: { latencyMs: 0 },
  };
}

function scripted(
  name: StrategyName,
  task: BenchTask,
  random: () => number,
): DecisionProvider {
  const byId = new Map(task.candidates.map((candidate) => [candidate.id, candidate]));
  return {
    async decide(request) {
      const ids = request.choices.map((choice) => choice.id).filter((id) => id !== UNKNOWN_CHOICE_ID);
      switch (name) {
        case "first":
          return pick(request, ids[0]!, "first");
        case "cheapest-first": {
          const ranked = [...ids].sort(
            (a, b) =>
              COST_RANK[byId.get(a)?.estimatedCost ?? "medium"] - COST_RANK[byId.get(b)?.estimatedCost ?? "medium"],
          );
          return pick(request, ranked[0]!, "cheapest-first");
        }
        case "oracle": {
          const solver = task.candidates.find((candidate) => candidate.solves)!;
          return pick(request, ids.includes(solver.id) ? solver.id : ids[0]!, "oracle");
        }
        default: {
          // Random over real candidates only; letting it pick "unknown" would just end the run early.
          const result = await new RandomDecisionProvider(random).decide({ ...request, allowUnknown: false });
          return result;
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// One trial

/**
 * Failure classification, following Terminal-Bench's command/trajectory error
 * taxonomy. Terminal-Bench found "executable not installed / not in PATH" was
 * the single most common command failure (24.1%), so it is tracked separately
 * from an ordinary verifier failure.
 */
export type FailureKind =
  | "invalid-edit"
  | "command-not-found"
  | "timeout"
  | "verifier-failed"
  | "no-experiment";

export interface TrialMetrics {
  solved: boolean;
  status: string;
  /** Candidates executed (= rounds, since topK is 1). */
  experiments: number;
  /** Verifier executions, including the grounding run before search. */
  verifierRuns: number;
  decisionCalls: number;
  patchesApplied: number;
  /** Edit attempts whose target file or text did not exist: a proxy for hallucinated repo claims. */
  invalidEdits: number;
  /** Tokens billed by decision/generator providers across the trial (0 for scripted strategies). */
  tokens: number;
  /** Provider-reported cost in USD (0 when the provider does not report cost). */
  costUsd: number;
  /** Classification of the last failure; unset when solved. */
  failureKind?: FailureKind;
  wallMs: number;
  executed: string[];
}

export interface BenchResult extends TrialMetrics {
  task: string;
  strategy: StrategyName;
  trial: number;
  seed: number;
}

interface TrialOptions {
  task: BenchTask;
  strategy: StrategyName;
  seed: number;
  tools: ToolPaths;
  maxRounds: number;
  configured?: DecisionProvider;
}

async function runTrial(options: TrialOptions): Promise<TrialMetrics> {
  const { task, tools } = options;
  const work = await mkdtemp(join(tmpdir(), `lattice-bench-${task.id}-`));
  const started = performance.now();
  try {
    await cp(task.repoDir, work, { recursive: true, filter: (source) => !IGNORED(source.split("/").pop() ?? "") });

    const tried = new Set<string>();
    const executed: string[] = [];
    let verifierRuns = 0;
    let decisionCalls = 0;
    let patchesApplied = 0;
    let invalidEdits = 0;
    let solved = false;
    let tokens = 0;
    let costUsd = 0;
    let lastFailure: FailureKind | undefined;

    const trackUsage = (usage: ProviderUsage | undefined) => {
      tokens += usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
      costUsd += usage?.costUsd ?? 0;
    };

    const generator: GeneratorProvider = {
      async generate(request) {
        const untried = task.candidates.filter((candidate) => !tried.has(candidate.id));
        const offered = (untried.length ? untried : task.candidates).map(
          ({ id, label, action, expectedEvidence, estimatedCost }) => ({ id, label, action, expectedEvidence, estimatedCost }),
        );
        const result = {
          text: JSON.stringify({ candidates: offered }),
          identity: { provider: "bench-scripted" },
          usage: { latencyMs: 0 },
        };
        trackUsage(result.usage);
        return result;
      },
    };

    const base =
      options.strategy === "configured"
        ? options.configured!
        : scripted(options.strategy, task, seededRandom(options.seed));
    const decision: DecisionProvider = {
      async decide(request) {
        decisionCalls++;
        const result = await base.decide(request);
        trackUsage(result.usage);
        return result;
      },
    };

    const executor: ExperimentExecutor = {
      async execute(candidate: CandidateAction): Promise<ExperimentOutcome> {
        const spec = task.candidates.find((item) => item.id === candidate.id)!;
        tried.add(candidate.id);
        executed.push(candidate.id);

        let restore: (() => Promise<void>) | undefined;
        let note = "no edit";
        if (spec.patch) {
          const path = join(work, spec.patch.file);
          const original = await readFile(path, "utf8").catch(() => undefined);
          if (original === undefined || !original.includes(spec.patch.find)) {
            invalidEdits++;
            lastFailure = "invalid-edit";
            return {
              candidateId: candidate.id,
              status: "failure",
              terminal: false,
              summary: `invalid edit: ${spec.patch.file} ${original === undefined ? "does not exist" : "has no matching text"}`,
              evidence: [],
            };
          }
          await writeFile(path, original.replace(spec.patch.find, spec.patch.replace));
          restore = () => writeFile(path, original);
          patchesApplied++;
          note = `edited ${spec.patch.file}`;
        }

        verifierRuns++;
        const { ok, result } = await passes(task, work, tools);
        if (!ok) await restore?.();
        solved ||= ok;
        if (!ok) lastFailure = classifyVerifierFailure(result);
        return {
          candidateId: candidate.id,
          status: ok ? "success" : "failure",
          terminal: ok,
          summary: `${note}; verifier exit=${result.exitCode}`,
          evidence: [
            {
              id: `ev:bench-${candidate.id}-${verifierRuns}`,
              kind: "test",
              verified: true,
              source: [result.command, ...result.args].join(" "),
              summary: `exit=${result.exitCode} ${result.stdout.trim().slice(0, 200)}`,
              createdAt: new Date().toISOString(),
            },
          ],
        };
      },
    };

    const run = await runTask(task.task, {
      cwd: work,
      verifyCommand: verifySpec(task, work, tools),
      search: {
        generator,
        decision,
        executor,
        maxRounds: options.maxRounds,
        candidatesPerRound: 8,
        topK: 1,
        autonomy: { mode: "autopilot" },
      },
    });
    verifierRuns++; // the grounding run inside runTask
    const status = /search (\w+) after/.exec(run.summary)?.[1] ?? "unknown";

    return {
      solved,
      status,
      experiments: executed.length,
      verifierRuns,
      decisionCalls,
      patchesApplied,
      invalidEdits,
      tokens,
      costUsd,
      failureKind: solved ? undefined : (lastFailure ?? "no-experiment"),
      wallMs: Math.round(performance.now() - started),
      executed,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Classify a failing verifier run: missing executable, timeout, or ordinary failure. */
function classifyVerifierFailure(result: CommandResult): FailureKind {
  if (result.timedOut) return "timeout";
  // POSIX convention: 127 = command not found; shells/shells-less spawns also surface ENOENT.
  if (result.exitCode === 127 || /ENOENT|command not found|not found/i.test(result.stderr)) {
    return "command-not-found";
  }
  return "verifier-failed";
}

// ---------------------------------------------------------------------------
// Suite run

export interface BenchOptions {
  strategies?: StrategyName[];
  trials?: number;
  seed?: number;
  maxRounds?: number;
  /** Only tasks whose id is listed. */
  only?: string[];
  tools?: ToolPaths;
  /** Decision provider for the `configured` strategy (a real model). */
  configured?: DecisionProvider;
  configuredDescription?: string;
  /** Trials that may run concurrently. Default 1 (fully sequential). */
  concurrency?: number;
  /** pass@k values to compute per task, e.g. [1, 5]. Default: [1] plus 5 when trials >= 5. */
  passAtK?: number[];
}

export interface StrategySummary {
  strategy: StrategyName;
  runs: number;
  solved: number;
  solveRate: number;
  /** 95% Wilson score interval for solveRate. Wide when runs is small. */
  solveRateCI95: [number, number];
  /** pass@k per task, averaged over tasks with at least k trials. Empty when every strategy ran once. */
  passAtK: Array<{ k: number; value: number }>;
  meanExperiments: number;
  meanVerifierRuns: number;
  meanDecisionCalls: number;
  meanTokens: number;
  totalCostUsd: number;
  /** Recorded provider cost per solved run; null when nothing was solved or cost is unreported. */
  costPerSolved: number | null;
  meanWallMs: number;
  invalidEdits: number;
  /** Failure-kind histogram over unsolved runs. */
  failures: Array<{ kind: FailureKind; count: number }>;
}

export interface TaskStrategySummary {
  task: string;
  strategy: StrategyName;
  runs: number;
  solved: number;
  solveRate: number;
  passAtK: Array<{ k: number; value: number }>;
  meanVerifierRuns: number;
  meanTokens: number;
  costUsd: number;
  failures: Array<{ kind: FailureKind; count: number }>;
}

export interface BenchReport {
  schemaVersion: typeof BENCH_SCHEMA_VERSION;
  generatedAt: string;
  suite: { name: string; digest: string; tasks: string[] };
  skipped: Array<{ task: string; reason: string }>;
  environment: {
    node: string;
    platform: string;
    tsr?: string;
    tsrRevision?: string;
    latticeRevision?: string;
    concurrency: number;
  };
  config: {
    strategies: StrategyName[];
    trials: number;
    seed: number;
    maxRounds: number;
    concurrency: number;
    passAtK: number[];
    configured?: string;
  };
  note: string;
  summary: StrategySummary[];
  /** Per-task × per-strategy breakdown; deterministic strategies contribute a single run per task. */
  byTask: TaskStrategySummary[];
  /** Solve-rate rollup by task metadata difficulty ("unrated" when absent). */
  byDifficulty: Array<{ difficulty: TaskDifficulty | "unrated"; runs: number; solved: number; solveRate: number }>;
  /** Comparison against a baseline report, when one was supplied. */
  comparison?: BenchmarkComparison;
  results: BenchResult[];
}

async function gitRevision(dir: string): Promise<string | undefined> {
  const run = (args: string[]) => runCommand({ command: "git", args, cwd: dir, timeoutMs: 5_000 }).catch(() => undefined);
  const revision = await run(["rev-parse", "--short=12", "HEAD"]);
  if (revision?.exitCode !== 0) return undefined;
  // Uncommitted changes mean the revision alone does not identify what was measured.
  // The beads issue log changes on every `bd` call and does not affect what was measured.
  const status = await run(["status", "--porcelain", "--untracked-files=no", "--", ".", ":(exclude).beads"]);
  return revision.stdout.trim() + (status?.stdout.trim() ? "+dirty" : "");
}

/** Wilson score interval: behaves sensibly for small n and rates near 0 or 1. */
export function wilson95(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

/**
 * Unbiased pass@k estimator (Chen et al., 2021): the probability that at least
 * one of k sampled trials succeeds, estimated from n trials with c successes.
 * Returns NaN when there are fewer than k trials — the caller must not average
 * those in.
 */
export function passAtK(n: number, c: number, k: number): number {
  if (k <= 0 || n <= 0) return Number.NaN;
  if (n < k) return Number.NaN;
  if (c === 0) return 0;
  if (n - c < k) return 1;
  let miss = 1;
  for (let i = 0; i < k; i++) miss *= (n - c - i) / (n - i);
  return 1 - miss;
}

function passAtKSummary(rows: BenchResult[], ks: number[]): Array<{ k: number; value: number }> {
  const n = rows.length;
  const c = rows.filter((row) => row.solved).length;
  return ks
    .map((k) => ({ k, value: passAtK(n, c, k) }))
    .filter((entry) => Number.isFinite(entry.value));
}

function failureHistogram(rows: BenchResult[]): Array<{ kind: FailureKind; count: number }> {
  const counts = new Map<FailureKind, number>();
  for (const row of rows) {
    if (row.solved) continue;
    const kind = row.failureKind ?? "no-experiment";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
}

/** Run `items` through `fn` with at most `limit` in flight, resolving results in input order. */
async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runBenchmark(suite: BenchSuite, options: BenchOptions = {}): Promise<BenchReport> {
  const strategies = options.strategies ?? [...OFFLINE_STRATEGIES];
  const trials = options.trials ?? 40;
  const seed = options.seed ?? 1;
  // Half the candidate budget: a strategy that wastes rounds should be able to fail, not just be slower.
  const maxRounds = options.maxRounds ?? 2;
  const concurrency = options.concurrency ?? 1;
  const passK = options.passAtK ?? [1, ...(trials >= 5 ? [5] : [])];
  if (!Number.isInteger(trials) || trials < 1) throw new Error("trials must be a positive integer");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
  if (strategies.includes("configured") && !options.configured) {
    throw new Error("strategy `configured` needs a decision provider (pass --config with a model)");
  }

  const tools = options.tools ?? (await resolveTools());
  const skipped: BenchReport["skipped"] = [];
  const tasks = suite.tasks.filter((task) => {
    if (options.only && !options.only.includes(task.id)) return false;
    const missing = missingTools(task, tools);
    if (missing.length) {
      skipped.push({ task: task.id, reason: `missing tool: ${missing.join(", ")}` });
      return false;
    }
    return true;
  });
  if (options.only) {
    const unknown = options.only.filter((id) => !suite.tasks.some((task) => task.id === id));
    if (unknown.length) throw new Error(`unknown task(s): ${unknown.join(", ")}`);
  }

  interface Job {
    task: BenchTask;
    strategy: StrategyName;
    trial: number;
    seed: number;
  }
  const jobs: Job[] = [];
  for (const task of tasks) {
    for (const strategy of strategies) {
      // Deterministic strategies give identical results on every repeat, so they run once.
      // `random` varies with the seed and `configured` (a real model) is nondeterministic.
      const repeats = strategy === "random" || strategy === "configured" ? trials : 1;
      for (let trial = 0; trial < repeats; trial++) {
        jobs.push({ task, strategy, trial, seed: seed + trial });
      }
    }
  }

  // Trials are independent (own temp dirs, per-trial seeds), so they parallelize
  // safely; results are placed back into job order, keeping reports deterministic.
  const metrics = await runPool(jobs, concurrency, (job) =>
    runTrial({
      task: job.task,
      strategy: job.strategy,
      seed: job.seed,
      tools,
      maxRounds,
      configured: options.configured,
    }),
  );
  const results: BenchResult[] = jobs.map((job, index) => ({
    task: job.task.id,
    strategy: job.strategy,
    trial: job.trial,
    seed: job.seed,
    ...metrics[index]!,
  }));

  const summary: StrategySummary[] = strategies.map((strategy) => {
    const rows = results.filter((row) => row.strategy === strategy);
    const solved = rows.filter((row) => row.solved).length;
    const cost = rows.reduce((total, row) => total + row.costUsd, 0);
    return {
      strategy,
      runs: rows.length,
      solved,
      solveRate: rows.length ? solved / rows.length : 0,
      solveRateCI95: wilson95(solved, rows.length),
      meanTokens: mean(rows.map((row) => row.tokens)),
      totalCostUsd: cost,
      costPerSolved: solved > 0 && cost > 0 ? cost / solved : null,
      meanExperiments: mean(rows.map((row) => row.experiments)),
      meanVerifierRuns: mean(rows.map((row) => row.verifierRuns)),
      meanDecisionCalls: mean(rows.map((row) => row.decisionCalls)),
      meanWallMs: mean(rows.map((row) => row.wallMs)),
      invalidEdits: rows.reduce((total, row) => total + row.invalidEdits, 0),
      passAtK: passAtKSummary(rows, passK),
      failures: failureHistogram(rows),
    };
  });

  const byTask: TaskStrategySummary[] = tasks.flatMap((task) =>
    strategies.map((strategy) => {
      const rows = results.filter((row) => row.task === task.id && row.strategy === strategy);
      return {
        task: task.id,
        strategy,
        runs: rows.length,
        solved: rows.filter((row) => row.solved).length,
        solveRate: rows.length ? rows.filter((row) => row.solved).length / rows.length : 0,
        passAtK: passAtKSummary(rows, passK),
        meanVerifierRuns: mean(rows.map((row) => row.verifierRuns)),
        meanTokens: mean(rows.map((row) => row.tokens)),
        costUsd: rows.reduce((total, row) => total + row.costUsd, 0),
        failures: failureHistogram(rows),
      };
    }),
  );

  const byDifficulty = new Map<TaskDifficulty | "unrated", { runs: number; solved: number }>();
  for (const task of tasks) {
    const difficulty = task.metadata?.difficulty ?? "unrated";
    const bucket = byDifficulty.get(difficulty) ?? { runs: 0, solved: 0 };
    const rows = results.filter((row) => row.task === task.id);
    bucket.runs += rows.length;
    bucket.solved += rows.filter((row) => row.solved).length;
    byDifficulty.set(difficulty, bucket);
  }

  const tsrRoot = tools.tsr ? resolve(dirname(tools.tsr), "..", "..") : undefined;
  return {
    schemaVersion: BENCH_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    suite: { name: suite.name, digest: suite.digest, tasks: tasks.map((task) => task.id) },
    skipped,
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      tsr: tools.tsr,
      tsrRevision: tsrRoot ? await gitRevision(tsrRoot) : undefined,
      latticeRevision: await gitRevision(suite.dir),
      concurrency,
    },
    config: {
      strategies,
      trials,
      seed,
      maxRounds,
      concurrency,
      passAtK: passK,
      configured: options.configuredDescription,
    },
    note:
      "Generator and executor are deterministic stand-ins; only the decision strategy varies. " +
      "These numbers measure orchestration logic, not model quality (use the `configured` strategy for that).",
    summary,
    byTask,
    byDifficulty: [...byDifficulty].map(([difficulty, bucket]) => ({
      difficulty,
      runs: bucket.runs,
      solved: bucket.solved,
      solveRate: bucket.runs ? bucket.solved / bucket.runs : 0,
    })),
    results,
  };
}

// ---------------------------------------------------------------------------
// Report comparison (regression gate for CI)

export interface StrategyDelta {
  strategy: StrategyName;
  baselineSolveRate: number;
  candidateSolveRate: number;
  baselineRuns: number;
  candidateRuns: number;
  delta: number;
  regressed: boolean;
}

export interface BenchmarkComparison {
  /** Solve-rate drops larger than the tolerance. */
  regressions: StrategyDelta[];
  /** Solve-rate gains larger than the tolerance. */
  improvements: StrategyDelta[];
  /** Suite digest changed between baseline and candidate: the task set is not the same. */
  suiteChanged: boolean;
  tolerance: number;
}

/**
 * Compare a candidate report against a baseline report per strategy. A strategy
 * present in both is "regressed" when its solve rate drops by more than the
 * tolerance (default 0: on a deterministic suite any drop is real). Strategies
 * missing from the candidate are reported as fully regressed so a removed
 * strategy cannot silently pass a gate.
 */
export function compareBenchReports(
  baseline: BenchReport,
  candidate: BenchReport,
  tolerance = 0,
): BenchmarkComparison {
  const regressions: StrategyDelta[] = [];
  const improvements: StrategyDelta[] = [];
  const baselineRows = new Map(baseline.summary.map((row) => [row.strategy, row]));
  const candidateRows = new Map(candidate.summary.map((row) => [row.strategy, row]));

  for (const [strategy, base] of baselineRows) {
    const next = candidateRows.get(strategy);
    const candidateRate = next?.solveRate ?? 0;
    const delta = candidateRate - base.solveRate;
    const entry: StrategyDelta = {
      strategy,
      baselineSolveRate: base.solveRate,
      candidateSolveRate: candidateRate,
      baselineRuns: base.runs,
      candidateRuns: next?.runs ?? 0,
      delta,
      regressed: delta < -tolerance,
    };
    (entry.regressed ? regressions : delta > tolerance ? improvements : []).push(entry);
  }

  return {
    regressions,
    improvements,
    suiteChanged: baseline.suite.digest !== candidate.suite.digest,
    tolerance,
  };
}

export function formatComparison(comparison: BenchmarkComparison): string {
  const lines: string[] = [];
  if (comparison.suiteChanged) lines.push("warning: suite digest changed; baseline and candidate measured different tasks");
  for (const item of [...comparison.regressions, ...comparison.improvements]) {
    const pct = (value: number) => `${Math.round(value * 100)}%`;
    const arrow = item.regressed ? "REGRESSED" : "improved";
    lines.push(
      `${arrow} ${item.strategy}: ${pct(item.baselineSolveRate)} -> ${pct(item.candidateSolveRate)} ` +
        `(${item.delta >= 0 ? "+" : ""}${(item.delta * 100).toFixed(1)}pp, tolerance ${pct(comparison.tolerance)})`,
    );
  }
  if (!lines.length) lines.push("no strategy changed beyond tolerance");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Self-check and reporting

export interface SelfCheckRow {
  task: string;
  baselineFails: boolean;
  solutionPasses: boolean;
  skipped?: string;
}

/** Every task must fail as shipped and pass once its `solves` patch is applied. */
export async function selfCheckSuite(suite: BenchSuite, tools?: ToolPaths): Promise<SelfCheckRow[]> {
  const resolved = tools ?? (await resolveTools());
  const rows: SelfCheckRow[] = [];
  for (const task of suite.tasks) {
    const missing = missingTools(task, resolved);
    if (missing.length) {
      rows.push({ task: task.id, baselineFails: false, solutionPasses: false, skipped: `missing tool: ${missing.join(", ")}` });
      continue;
    }
    const work = await mkdtemp(join(tmpdir(), `lattice-check-${task.id}-`));
    try {
      await mkdir(work, { recursive: true });
      await cp(task.repoDir, work, { recursive: true, filter: (source) => !IGNORED(source.split("/").pop() ?? "") });
      const baselineFails = !(await passes(task, work, resolved)).ok;
      const patch = task.candidates.find((candidate) => candidate.solves)!.patch!;
      const file = join(work, patch.file);
      const original = await readFile(file, "utf8");
      if (!original.includes(patch.find)) {
        rows.push({ task: task.id, baselineFails, solutionPasses: false });
        continue;
      }
      await writeFile(file, original.replace(patch.find, patch.replace));
      rows.push({ task: task.id, baselineFails, solutionPasses: (await passes(task, work, resolved)).ok });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  return rows;
}

export function formatReport(report: BenchReport): string {
  const pad = (value: string, width: number) => value.padEnd(width);
  const passKText = (row: { passAtK: Array<{ k: number; value: number }> }) =>
    row.passAtK.length ? row.passAtK.map((entry) => `@${entry.k}=${(entry.value * 100).toFixed(0)}%`).join(",") : "-";
  const passKWidth = Math.max(9, ...report.summary.map((row) => passKText(row).length));
  const lines = [
    `suite ${report.suite.name} (${report.suite.tasks.length} task(s), digest ${report.suite.digest.slice(0, 12)})`,
    `trials=${report.config.trials} seed=${report.config.seed} maxRounds=${report.config.maxRounds} concurrency=${report.config.concurrency}` +
      `${report.environment.tsr ? `  tsr=${report.environment.tsrRevision ?? "?"}` : ""}` +
      `${report.environment.latticeRevision ? `  lattice=${report.environment.latticeRevision}` : ""}`,
    "",
    `${pad("strategy", 16)}${pad("solved", 16)}${pad("95% CI", 13)}${pad("pass@k", passKWidth + 1)}${pad("experiments", 13)}${pad("verifier runs", 15)}${pad("decisions", 11)}${pad("tokens", 10)}${pad("cost $", 10)}${pad("invalid edits", 15)}wall ms`,
  ];
  for (const row of report.summary) {
    lines.push(
      pad(row.strategy, 16) +
        pad(`${row.solved}/${row.runs} (${Math.round(row.solveRate * 100)}%)`, 16) +
        pad(`${Math.round(row.solveRateCI95[0] * 100)}–${Math.round(row.solveRateCI95[1] * 100)}%`, 13) +
        pad(passKText(row), passKWidth + 1) +
        pad(row.meanExperiments.toFixed(2), 13) +
        pad(row.meanVerifierRuns.toFixed(2), 15) +
        pad(row.meanDecisionCalls.toFixed(2), 11) +
        pad(row.meanTokens.toFixed(0), 10) +
        pad(row.totalCostUsd > 0 ? row.totalCostUsd.toFixed(4) : "-", 10) +
        pad(String(row.invalidEdits), 15) +
        row.meanWallMs.toFixed(0),
    );
    if (row.costPerSolved !== null) lines.push(`  cost per solved: $${row.costPerSolved.toFixed(4)}`);
    for (const failure of row.failures) lines.push(`  failure ${failure.kind}: ${failure.count}`);
  }

  if (report.byTask.length > report.summary.length) {
    lines.push("", "per task:");
    for (const row of report.byTask) {
      lines.push(
        `  ${pad(row.task, 22)}${pad(row.strategy, 16)}${pad(`${row.solved}/${row.runs}`, 10)}` +
          `verifier runs ${row.meanVerifierRuns.toFixed(2)}  tokens ${row.meanTokens.toFixed(0)}`,
      );
    }
  }

  if (report.byDifficulty.length > 1) {
    lines.push("", "by difficulty:");
    for (const row of report.byDifficulty) {
      lines.push(`  ${pad(row.difficulty, 10)}${pad(`${row.solved}/${row.runs}`, 10)}(${Math.round(row.solveRate * 100)}%)`);
    }
  }

  for (const item of report.skipped) lines.push(`skipped ${item.task}: ${item.reason}`);
  if (report.comparison) lines.push("", formatComparison(report.comparison));
  lines.push("", `note: ${report.note}`);
  return lines.join("\n");
}

/** Deterministic sharding for parallel CI: shard `i` of `n` gets items where index % n == i. */
export function selectShard<T>(items: T[], shard: string): T[] {
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(shard.trim());
  if (!match) throw new Error(`--shard must look like "i/n" (1-based), got: ${shard}`);
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 1 || index > count) {
    throw new Error(`--shard index and count must satisfy 1 <= i <= n (got ${shard})`);
  }
  return items.filter((_, position) => position % count === index - 1);
}

export async function configuredProvider(
  cwd: string,
  configPath?: string,
): Promise<{ provider: DecisionProvider; description: string }> {
  const loaded = await loadLatticeConfig(cwd, configPath);
  const provider = loaded ? createDecisionProvider(loaded.config) : undefined;
  if (!loaded || !provider) {
    throw new Error("no decision model configured (set model or models.decision in the Lattice config)");
  }
  const model = loaded.config.models?.decision ?? loaded.config.model!;
  const description =
    "provider" in model && model.provider === "random"
      ? `random (seed: ${model.seed ?? "default"})`
      : `${(model as { model: string; baseUrl: string }).model} @ ${(model as { model: string; baseUrl: string }).baseUrl}`;
  return { provider, description };
}

export * from "./verse.js";
