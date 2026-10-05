// MVP slice: Lattice repairs a deliberately broken Tessera program and `tsr`
// alone decides success. Each candidate is a whole replacement file; the
// executor verifies it with `tsr witness` (+ `tsr run` cases) and only a
// verified candidate is written back. Runs record rounds, verifier calls,
// tokens and cost so a configured decider can be compared with random choice.
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { runTask } from "@lattice/core";
import {
  UNKNOWN_CHOICE_ID,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResult,
  type GeneratorProvider,
  type GeneratorResult,
  type ProviderIdentity,
  type ProviderUsage,
  type RunEvent,
  type TapPacket,
} from "@lattice/protocol";
import { seededRandom } from "@lattice/providers";
import type {
  CandidateAction,
  ExperimentExecutor,
  ExperimentOutcome,
  ProposalPrompt,
} from "@lattice/search";
import {
  createWitnessVerifier,
  toVerificationRecord,
  verifyTessera,
  type CandidateLineage,
  type CandidateSource,
  type OverflowMode,
  type SelectionSource,
  type RunCase,
  type TesseraVerificationRecord,
  type TesseraVerifySpec,
  type WitnessPhase,
} from "./witness.js";
import {
  SUGGESTION_ID_PREFIX,
  SUGGESTION_PROVIDER,
  SuggestionFirstGenerator,
  loadGrammar,
  renderAttempts,
  renderVerdict,
  witnessSuggestions,
  type Attempt,
  type WitnessSuggestion,
} from "./feedback.js";

/** `task.json` in a repair task directory. */
export interface RepairTask {
  name: string;
  /** Directory holding `task.json` and the program. */
  dir: string;
  description: string;
  /** Program file, relative to `dir`. */
  file: string;
  phase?: WitnessPhase;
  overflow: OverflowMode;
  cases: RunCase[];
}

export async function loadRepairTask(dir: string): Promise<RepairTask> {
  const root = resolve(dir);
  const raw = JSON.parse(await readFile(join(root, "task.json"), "utf8")) as Partial<RepairTask>;
  if (
    typeof raw.file !== "string" ||
    isAbsolute(raw.file) ||
    relative(root, resolve(root, raw.file)).startsWith("..")
  ) {
    throw new Error(`${root}/task.json: file must be a relative path inside the task directory`);
  }
  if (raw.overflow !== "wrapping" && raw.overflow !== "trapping") {
    throw new Error(`${root}/task.json: overflow must be wrapping or trapping`);
  }
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error(`${root}/task.json: at least one case is required`);
  }
  return {
    name: raw.name ?? basename(root),
    dir: root,
    description: raw.description ?? `make ${raw.file} pass tsr witness and its cases`,
    file: raw.file,
    phase: raw.phase,
    overflow: raw.overflow,
    cases: raw.cases,
  };
}

export function verifySpecFor(task: RepairTask, tsr?: string): TesseraVerifySpec {
  return {
    tsr,
    file: task.file,
    phase: task.phase,
    overflow: task.overflow,
    cases: task.cases,
  };
}

// ---------------------------------------------------------------------------
// TC surface helpers (one `f name(p:T,...)>T=expr` per file, `+` only).

interface TcFunction {
  header: string;
  params: string[];
  terms: string[];
}

const HEADER = /^\s*(f\s+[A-Za-z_]\w*\s*\(([^)]*)\)\s*>\s*[A-Za-z_]\w*\s*=)(.*)$/s;

export function parseTcFunction(source: string): TcFunction | undefined {
  const match = HEADER.exec(source.trim());
  if (!match) return undefined;
  const params = match[2]!
    .split(",")
    .map((p) => p.split(":")[0]!.trim())
    .filter(Boolean);
  const terms = match[3]!
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean);
  return { header: match[1]!.replace(/\s+/g, (ws) => (ws.includes("\n") ? " " : ws)), params, terms };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Bodies reachable by small edits: sums of up to three parameters, the
 * original sum with one term dropped, and the original with each unknown name
 * replaced by a parameter. This is a mutation enumerator, not a model.
 */
export function mutationBodies(fn: TcFunction): string[] {
  const out = new Set<string>();
  const { params, terms } = fn;
  const maxTerms = Math.min(3, Math.max(2, terms.length + 1));
  const grow = (prefix: string[]) => {
    if (prefix.length) out.add(prefix.join("+"));
    if (prefix.length === maxTerms) return;
    for (const p of params) grow([...prefix, p]);
  };
  grow([]);
  for (let i = 0; i < terms.length && terms.length > 1; i++) {
    out.add(terms.filter((_, j) => j !== i).join("+"));
  }
  terms.forEach((term, i) => {
    if (/^[A-Za-z_]\w*$/.test(term) && !params.includes(term)) {
      for (const p of params) out.add(terms.map((t, j) => (j === i ? p : t)).join("+"));
    }
  });
  out.delete(terms.join("+"));
  return [...out];
}

function zeroUsage(): ProviderUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, latencyMs: 0 };
}

/**
 * Offline stand-in for the generator: proposes untried mutations of the
 * original program in a seeded order. Spends no tokens.
 */
export class MutationRepairGenerator implements GeneratorProvider {
  private readonly queue: string[];
  private readonly header: string;

  constructor(original: string, seed: number) {
    // Not TC at all (e.g. Rust-style): nothing to mutate, so it proposes nothing.
    const fn = parseTcFunction(original);
    this.queue = fn
      ? shuffle(mutationBodies(fn), seededRandom(seed)).map((body) => `${fn.header}${body}\n`)
      : [];
    this.header = fn?.header ?? "";
  }

  /** Offers the first untried mutations; ones the context lists as tried are dropped. */
  async generate(request: { prompt: string; context?: string[] }): Promise<GeneratorResult> {
    const count = Number(/up to (\d+)/.exec(request.prompt)?.[1] ?? 4);
    const tried = new Set(
      (request.context ?? [])
        .filter((block) => block.startsWith(TRIED_HEADER))
        .flatMap((block) => block.split("\n").slice(1).map((line) => line.trim())),
    );
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (tried.has(this.queue[i]!.trim())) this.queue.splice(i, 1);
    }
    const batch = this.queue.slice(0, count);
    const candidates = batch.map((source) => ({
      id: `m${createHash("sha256").update(source).digest("hex").slice(0, 8)}`,
      label: `set body to ${source.slice(this.header.length).trim()}`,
      action: source,
      expectedEvidence: "tsr witness pass and every run case matches",
      estimatedCost: "low",
    }));
    return {
      text: JSON.stringify({ candidates }),
      identity: { provider: "stub", model: "tc-mutations" },
      usage: zeroUsage(),
    };
  }
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

/** The candidate source a repair choice carries (see `compileDecisionFrame`). */
export function choiceSource(detail: string | undefined): string | undefined {
  return /action: ([\s\S]*?) \| expected evidence:/.exec(detail ?? "")?.[1];
}

/**
 * Offline stand-in for a cheap decision model: prefers the smallest edit to
 * the original and avoids names `tsr` reported as unbound. It reads only the
 * decision request, as a real decider would. Spends no tokens.
 */
export class HeuristicRepairDecider implements DecisionProvider {
  constructor(private readonly original: string) {}

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const unbound = new Set(
      [...(request.state ?? "").matchAll(/unbound variable `([^`]+)`/g)].map((m) => m[1]!),
    );
    const raw: Record<string, number> = {};
    for (const choice of request.choices) {
      const source = choiceSource(choice.detail) ?? choice.label;
      const names = source.split(/[^A-Za-z0-9_]+/);
      const penalty = names.some((n) => unbound.has(n)) ? 0.05 : 1;
      raw[choice.id] = penalty / (1 + editDistance(this.original.trim(), source.trim()));
    }
    const total = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
    const scores = Object.fromEntries(Object.entries(raw).map(([id, v]) => [id, v / total]));
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    return {
      selected: ranked.length ? [ranked[0]![0]] : [UNKNOWN_CHOICE_ID],
      scores,
      confidence: ranked[0]?.[1],
      identity: { provider: "stub", model: "edit-distance-heuristic" },
      usage: zeroUsage(),
    };
  }
}

// ---------------------------------------------------------------------------
// Proposal prompt for real models.

export const TRIED_HEADER = "ALREADY TRIED AND REJECTED BY TSR (do not propose again):";

export interface RepairFeedback {
  /** `tsr grammar` output, when this `tsr` has the command. */
  grammar?: string;
  /** The latest verification of the current file. */
  current?: () => TesseraVerificationRecord | undefined;
  /** Rejected candidates with their verifications, oldest first. */
  attempts?: () => Attempt[];
}

export function repairProposal(
  task: RepairTask,
  readSource: () => Promise<string>,
  tried: () => string[] = () => [],
  feedback: RepairFeedback = {},
): ProposalPrompt {
  const cases = task.cases
    .map((c) => `${c.function}(${c.args.join(", ")}) must return ${c.expect}`)
    .join("; ");
  return {
    system:
      "You repair programs in Tessera's TC surface language. A program is one function: " +
      "`f NAME(PARAM:i64,...)>i64=EXPR`, where EXPR uses parameters, integer literals and `+` only. " +
      "There are no braces, `return`, semicolons, statements or other operators. " +
      "Example of a complete, valid program: `f twice(x:i64)>i64=x+x`. " +
      "The compiler (`tsr`) decides success; do not claim a fix works.",
    prompt: (count) =>
      [
        `Propose up to ${count} distinct candidate repairs of ${task.file}.`,
        `Required behaviour: ${cases}.`,
        "Use the compiler diagnostics and run results in the evidence. Each candidate's `action` is the COMPLETE new file content, nothing else.",
        "Return JSON only:",
        '{"candidates":[{"id":"a","label":"short neutral description of the change","action":"<complete file>","expectedEvidence":"tsr witness pass and cases match","estimatedCost":"low"}]}',
      ].join("\n"),
    context: async () => {
      const rejected = tried();
      const source = await readSource();
      const current = feedback.current?.();
      const attempts = renderAttempts(feedback.attempts?.() ?? []);
      return [
        ...(feedback.grammar ? [`TC GRAMMAR (from tsr grammar; the only accepted syntax):\n${feedback.grammar}`] : []),
        `CURRENT ${task.file}:\n${source}`,
        ...(current ? [`TSR ON CURRENT ${task.file}:\n${renderVerdict(source, current)}`] : []),
        ...(attempts ? [attempts] : []),
        ...(rejected.length ? [`${TRIED_HEADER}\n${rejected.map((s) => s.trim()).join("\n")}`] : []),
      ];
    },
  };
}

// ---------------------------------------------------------------------------
// Executor.

function addSuggestions(pool: WitnessSuggestion[], found: WitnessSuggestion[]): void {
  for (const s of found) {
    if (!pool.some((p) => p.source === s.source)) pool.push(s);
  }
}

export interface RepairExecutorOptions {
  task: RepairTask;
  /** Directory whose copy of `task.file` is repaired. */
  workspace: string;
  tsr?: string;
  /** Reuse verification of byte-identical candidates (results are deterministic per `tsr` build). */
  cache?: Map<string, TesseraVerificationRecord>;
  /** What selected the candidates this executor runs (read per candidate). */
  selectionSource?: () => SelectionSource;
}

/** Candidates whose id carries the suggestion prefix came from `tsr`, not the generator. */
export function candidateSource(candidateId: string): CandidateSource {
  return candidateId.startsWith(SUGGESTION_ID_PREFIX) ? "compiler_suggestion" : "model_generator";
}

/** The offline stand-ins and the random baseline are policies, not models. */
export function selectionSourceOf(identity: ProviderIdentity | undefined): SelectionSource {
  return !identity || identity.provider === "stub" || identity.provider === "random"
    ? "deterministic_policy"
    : "model_decision";
}

export interface RepairExecutorStats {
  /** Sources `tsr` rejected, in order. */
  tried: string[];
  /** The same rejections with what `tsr` said about each. */
  attempts: Attempt[];
  /** Checked whole-file repairs `tsr witness` offered, first seen first. */
  suggestions: WitnessSuggestion[];
  /** Lineage of the candidate that passed, if any. */
  accepted?: CandidateLineage;
  verifications: number;
  tsrProcesses: number;
  cacheHits: number;
}

export function createRepairExecutor(
  options: RepairExecutorOptions,
): ExperimentExecutor & { stats: RepairExecutorStats } {
  const stats: RepairExecutorStats = {
    tried: [],
    attempts: [],
    suggestions: [],
    verifications: 0,
    tsrProcesses: 0,
    cacheHits: 0,
  };
  const spec = verifySpecFor(options.task, options.tsr);
  let counter = 0;
  return {
    stats,
    async execute(candidate: CandidateAction, _tap: TapPacket): Promise<ExperimentOutcome> {
      const source = candidate.action.endsWith("\n") ? candidate.action : `${candidate.action}\n`;
      const key = createHash("sha256")
        .update([spec.tsr ?? process.env.TSR ?? "tsr", spec.phase ?? "check", spec.overflow, JSON.stringify(spec.cases), source].join("\0"))
        .digest("hex");
      stats.verifications++;

      let record = options.cache?.get(key);
      if (record) {
        stats.cacheHits++;
        record = { ...record, cached: true };
      } else {
        const dir = join(options.workspace, ".lattice", "candidates", `${++counter}-${candidate.id}`);
        await mkdir(dir, { recursive: true });
        const file = join(dir, basename(options.task.file));
        await writeFile(file, source, "utf8");
        record = await verifyTessera({ ...spec, file }, dir);
        record = { ...record, file: options.task.file };
        stats.tsrProcesses += 1 + record.cases.length;
        options.cache?.set(key, record);
      }

      const lineage: CandidateLineage = {
        candidateId: candidate.id,
        candidateSource: candidateSource(candidate.id),
        selectionSource: options.selectionSource?.() ?? "deterministic_policy",
      };
      record = { ...record, lineage };
      const verification = toVerificationRecord(record);
      if (verification.passed) {
        await writeFile(join(options.workspace, options.task.file), source, "utf8");
        stats.accepted = lineage;
      } else {
        stats.tried.push(source);
        stats.attempts.push({ source, record });
        addSuggestions(stats.suggestions, witnessSuggestions(record.witness.document));
      }
      return {
        candidateId: candidate.id,
        status: verification.passed ? "success" : "failure",
        terminal: verification.passed,
        summary: `${candidate.label}: ${verification.summary}`,
        evidence: verification.evidence,
        records: [record],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// One repair run, with metrics.

export interface Pricing {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Null when a call reported tokens but no price was given. */
  costUsd: number | null;
}

export interface RepairRunOptions {
  task: RepairTask;
  tsr?: string;
  /** Defaults to the seeded mutation generator. */
  generator?: GeneratorProvider;
  /** Defaults to the edit-distance heuristic. */
  decision?: DecisionProvider;
  /** Label for reports, e.g. `heuristic` or `random`. */
  arm?: string;
  seed?: number;
  maxRounds?: number;
  candidatesPerRound?: number;
  pricing?: Pricing;
  cache?: Map<string, TesseraVerificationRecord>;
  /** Keep the temporary workspace (default: removed). */
  keepWorkspace?: boolean;
  /** Where run logs go (default: inside the workspace). */
  latticeDir?: string;
  /**
   * Try `tsr witness`'s checked suggestions before calling the generator
   * (default true). They cost no tokens and are verified like any candidate.
   */
  suggestions?: boolean;
  /** Put `tsr grammar` in the proposal context (default true). */
  grammar?: boolean;
}

export interface RepairRunReport {
  task: string;
  arm: string;
  seed: number;
  status: "solved" | "blocked" | "budget_exhausted";
  rounds: number;
  verifications: number;
  tsrProcesses: number;
  cacheHits: number;
  generator: { identity?: ProviderIdentity } & UsageTotals;
  decision: { identity?: ProviderIdentity } & UsageTotals;
  tokens: number;
  costUsd: number | null;
  /** Verified final program when solved. */
  patch?: string;
  /** Witness `result_id` of the initial (broken) program. */
  initialResultId?: string;
  /** The `tsr` build that judged this run, from its witness document. */
  tsr?: { version: string; commit: string; dirty: boolean | null };
  runId: string;
  eventLogPath: string;
  workspace?: string;
  /** Set when the run stopped on an error (e.g. the generator ran out of candidates). */
  error?: string;
  /** Where the verified patch came from and what selected it; set when solved. */
  lineage?: CandidateLineage;
  /** Rounds answered by `tsr` suggestions without calling the generator (not in `generator`). */
  suggestionRounds: number;
}

function emptyTotals(): UsageTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
}

function addUsage(totals: UsageTotals, usage: ProviderUsage | undefined, pricing?: Pricing): void {
  totals.calls++;
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  totals.inputTokens += input;
  totals.outputTokens += output;
  totals.totalTokens += usage?.totalTokens ?? input + output;
  if (totals.costUsd === null) return;
  if (usage?.costUsd !== undefined) totals.costUsd += usage.costUsd;
  else if (pricing) {
    totals.costUsd += (input * pricing.inputPerMTok + output * pricing.outputPerMTok) / 1_000_000;
  } else if (input + output > 0) totals.costUsd = null;
}

export async function runRepair(options: RepairRunOptions): Promise<RepairRunReport> {
  const { task } = options;
  const seed = options.seed ?? 1;
  const workspace = await mkdtemp(join(tmpdir(), `lattice-tessera-${task.name}-`));
  await cp(task.dir, workspace, { recursive: true });
  const programPath = join(workspace, task.file);
  const original = await readFile(programPath, "utf8");

  const inner = options.generator ?? new MutationRepairGenerator(original, seed);
  const decision = options.decision ?? new HeuristicRepairDecider(original);
  const decisionTotals: RepairRunReport["decision"] = emptyTotals();
  const executor = createRepairExecutor({
    task,
    workspace,
    tsr: options.tsr,
    cache: options.cache,
    selectionSource: () => selectionSourceOf(decisionTotals.identity),
  });
  const generator =
    options.suggestions === false
      ? inner
      : new SuggestionFirstGenerator(inner, () => executor.stats.suggestions, () => executor.stats.tried);
  const grammar = options.grammar === false ? undefined : await loadGrammar(options.tsr);
  let current: TesseraVerificationRecord | undefined;

  // Model/generator spend only: rounds `tsr` answered are counted apart.
  const generatorTotals: RepairRunReport["generator"] = emptyTotals();
  let suggestionRounds = 0;
  let initialResultId: string | undefined;
  let tsrBuild: RepairRunReport["tsr"];

  const onEvent = (event: RunEvent) => {
    const payload = event.payload as Record<string, any>;
    const proposal = payload?.event?.type;
    if (
      event.type === "decision.requested" &&
      (proposal === "candidates.generated" || proposal === "candidates.rejected")
    ) {
      if (payload.event.identity?.provider === SUGGESTION_PROVIDER) {
        suggestionRounds++;
      } else {
        generatorTotals.identity = payload.event.identity;
        addUsage(generatorTotals, payload.event.usage, options.pricing);
      }
    } else if (event.type === "decision.completed" && payload?.type === "decision.completed") {
      decisionTotals.identity = payload.identity;
      addUsage(decisionTotals, payload.usage, options.pricing);
    } else if (event.type === "tool.completed" && payload?.tool === "tessera.witness") {
      current = payload.record as TesseraVerificationRecord;
      addSuggestions(executor.stats.suggestions, witnessSuggestions(current?.witness?.document));
      const document = payload.record?.witness?.document;
      initialResultId = document?.result_id;
      tsrBuild = document?.tool
        ? { version: document.tool.version, commit: document.tool.commit, dirty: document.tool.dirty }
        : undefined;
    }
  };

  const base = () => ({
    task: task.name,
    arm: options.arm ?? "configured",
    seed,
    verifications: executor.stats.verifications,
    tsrProcesses: executor.stats.tsrProcesses,
    cacheHits: executor.stats.cacheHits,
    generator: generatorTotals,
    decision: decisionTotals,
    tokens: generatorTotals.totalTokens + decisionTotals.totalTokens,
    costUsd:
      generatorTotals.costUsd === null || decisionTotals.costUsd === null
        ? null
        : generatorTotals.costUsd + decisionTotals.costUsd,
    initialResultId,
    tsr: tsrBuild,
    suggestionRounds,
  });

  let report: RepairRunReport;
  try {
    const result = await runTask(`repair ${task.file}: ${task.description}`, {
      cwd: workspace,
      latticeDir: options.latticeDir,
      onEvent,
      verifier: createWitnessVerifier(verifySpecFor(task, options.tsr)),
      search: {
        generator,
        decision,
        executor,
        maxRounds: options.maxRounds ?? 6,
        candidatesPerRound: options.candidatesPerRound ?? 4,
        topK: 1,
        autonomy: { mode: "autopilot" },
        // A strong model can abstain even when a viable repair is ranked; verify the top-scored candidate.
        onAbstain: "verify-top",
        proposal: repairProposal(task, () => readFile(programPath, "utf8"), () => executor.stats.tried, {
          grammar,
          current: () => current,
          attempts: () => executor.stats.attempts,
        }),
      },
    });
    const status = result.search?.status ?? "blocked";
    report = {
      ...base(),
      status,
      rounds: result.search?.rounds ?? 0,
      patch: status === "solved" ? await readFile(programPath, "utf8") : undefined,
      lineage: status === "solved" ? executor.stats.accepted : undefined,
      runId: result.runId,
      eventLogPath: result.eventLogPath,
    };
  } catch (error) {
    report = {
      ...base(),
      status: "blocked",
      rounds: generatorTotals.calls + suggestionRounds,
      runId: "",
      eventLogPath: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // The run log lives in the workspace unless latticeDir moved it out.
  if (options.latticeDir && !options.keepWorkspace) {
    await rm(workspace, { recursive: true, force: true });
  } else {
    report.workspace = workspace;
  }
  return report;
}
