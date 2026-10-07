// Milestone C exit criterion (docs/mvp.md): compare a decider against
// random choice on the same tasks, generator stream and seeds.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DecisionProvider,
  GeneratorProvider,
  GeneratorRequest,
  GeneratorResult,
} from "@lattice/protocol";
import { RandomDecisionProvider, seededRandom } from "@lattice/providers";
import {
  runRepair,
  type Pricing,
  type RepairRunReport,
  type RepeatMode,
  type RepairTask,
} from "./repair.js";
import type { TesseraVerificationRecord } from "./witness.js";
import type { RepairMemoryEntry } from "./memory.js";

export interface ComparisonArm {
  name: string;
  /** Fresh decider per run; `original` is the broken program. */
  decision: (seed: number, original: string) => DecisionProvider | undefined;
  /** Fresh generator per run; undefined uses the seeded mutation stub. */
  generator?: (seed: number, original: string) => GeneratorProvider | undefined;
}

/** Uniform choice among the generated candidates ("none" excluded). */
export function randomArm(generator?: ComparisonArm["generator"]): ComparisonArm {
  return {
    name: "random",
    // Offset the seed so the decider's stream is independent of the generator's.
    decision: (seed) =>
      new RandomDecisionProvider(seededRandom(seed * 7919 + 17), { allowUnknown: false }),
    generator,
  };
}

/**
 * Arms that share a generator factory must see the same candidates, or a
 * difference could come from the generator rather than the decider. The
 * first arm to reach round N for a task and seed calls the real generator;
 * later arms replay that round's reply, including its usage, since that is
 * what generating those candidates cost.
 */
export class RecordedRounds {
  private readonly rounds = new Map<string, GeneratorResult[]>();

  wrap(key: string, inner: GeneratorProvider): GeneratorProvider {
    const recorded = this.rounds.get(key) ?? [];
    this.rounds.set(key, recorded);
    let round = 0;
    return {
      async generate(request: GeneratorRequest): Promise<GeneratorResult> {
        const index = round++;
        if (index < recorded.length) return structuredClone(recorded[index]!);
        const result = await inner.generate(request);
        recorded.push(structuredClone(result));
        return result;
      },
    };
  }
}

export interface ComparisonOptions {
  tasks: RepairTask[];
  arms: ComparisonArm[];
  seeds: number[];
  tsr?: string;
  maxRounds?: number;
  candidatesPerRound?: number;
  pricing?: Pricing;
  /** Share verification of identical candidates across runs (default true). */
  cache?: boolean;
  /** Replay one generator stream per task and seed across arms (default true). */
  shareCandidates?: boolean;
  latticeDir?: string;
  /** Try `tsr witness` suggestions before the generator (default true; see `runRepair`). */
  suggestions?: boolean;
  /** Offer SEARCH/REPLACE edits in the proposal prompt (see `runRepair`). */
  edits?: boolean;
  /** Add the minimal-change rule to the proposal prompt (see `runRepair`). */
  minimal?: boolean;
  /** Repair memory shown to the generator (see `runRepair`); read-only during the comparison. */
  memory?: RepairMemoryEntry[];
  /** How repeated candidates are handled (see `runRepair`; default "canonical"). */
  repeats?: RepeatMode;
  onRun?: (report: RepairRunReport) => void;
}

export interface ArmSummary {
  task: string;
  arm: string;
  runs: number;
  solved: number;
  /** Solved by one of `tsr`'s own checked suggestions: a deterministic compiler repair, not a model result. */
  solvedByCompilerRepair: number;
  /** Solved by a candidate from the generator slot (the model, or the offline stub). */
  solvedByModelGenerator: number;
  unresolved: number;
  /** Means over solved runs; null when none solved. */
  meanRoundsToSolve: number | null;
  meanVerificationsToSolve: number | null;
  /** Mean characters changed from the broken program, over solved runs. */
  meanPatchDistance: number | null;
  /** Runs that were shown at least one memory example. */
  runsWithMemory: number;
  meanTokens: number;
  meanCostUsd: number | null;
  /**
   * Model efficiency: generator + decision spend of every run not solved by a
   * compiler repair, divided by generator-solved runs. Null when none.
   */
  modelTokensPerModelPatch: number | null;
  modelCostPerModelPatchUsd: number | null;
  /**
   * End-to-end workflow cost: all runs' spend divided by all solved runs,
   * compiler repairs included. Not a measure of model efficiency.
   */
  costPerVerifiedPatchUsd: number | null;
  tokensPerVerifiedPatch: number | null;
  /** Generator replies that could not be parsed, across the group (retried or fatal). */
  formatErrors: number;
  /** SEARCH/REPLACE candidates that did not apply, across the group. */
  editFailures: number;
  /** Candidates dropped as repeats of an attempt, across the group. */
  repeatsDropped: number;
  /** Generator replies made only of repeats, across the group (retried or stuck). */
  repeatReplies: number;
}

export interface ComparisonReport {
  schema: "lattice.tessera-comparison/v0";
  createdAt: string;
  tsr?: { version: string; commit: string; dirty: boolean | null };
  seeds: number[];
  maxRounds: number;
  candidatesPerRound: number;
  /** Whether `tsr` suggestions were tried before the generator; false is the generator-only ablation. */
  suggestions: boolean;
  /** Whether the minimal-change rule was in the prompt. */
  minimal?: boolean;
  /** Memory entries available to the runs (0: no memory). */
  memoryEntries?: number;
  /** How repeated candidates were handled; absent in reports from before repeat detection ("allow"). */
  repeats?: RepeatMode;
  runs: RepairRunReport[];
  summary: ArmSummary[];
}

const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** Sum of costs, or null when any is unknown. */
const sumCost = (values: Array<number | null>) =>
  values.includes(null) ? null : sum(values as number[]);

const byCompiler = (r: RepairRunReport) =>
  r.status === "solved" && r.lineage?.candidateSource === "compiler_suggestion";

export function summarize(runs: RepairRunReport[]): ArmSummary[] {
  const groups = new Map<string, RepairRunReport[]>();
  for (const run of runs) {
    const key = `${run.task}\0${run.arm}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.values()].map((group) => {
    const solved = group.filter((r) => r.status === "solved");
    const compiler = solved.filter(byCompiler);
    const model = solved.length - compiler.length;
    const totalCost = sumCost(group.map((r) => r.costUsd));
    const totalTokens = sum(group.map((r) => r.tokens));
    const modelRuns = group.filter((r) => !byCompiler(r));
    const modelCost = sumCost(modelRuns.map((r) => r.costUsd));
    return {
      task: group[0]!.task,
      arm: group[0]!.arm,
      runs: group.length,
      solved: solved.length,
      solvedByCompilerRepair: compiler.length,
      solvedByModelGenerator: model,
      unresolved: group.length - solved.length,
      meanRoundsToSolve: mean(solved.map((r) => r.rounds)),
      meanVerificationsToSolve: mean(solved.map((r) => r.verifications)),
      runsWithMemory: group.filter((r) => (r.memoryExamples ?? 0) > 0).length,
      meanPatchDistance: mean(solved.flatMap((r) => (r.patchDistance === undefined ? [] : [r.patchDistance]))),
      meanTokens: totalTokens / group.length,
      meanCostUsd: totalCost === null ? null : totalCost / group.length,
      modelTokensPerModelPatch: model ? sum(modelRuns.map((r) => r.tokens)) / model : null,
      modelCostPerModelPatchUsd: model && modelCost !== null ? modelCost / model : null,
      costPerVerifiedPatchUsd:
        totalCost === null || solved.length === 0 ? null : totalCost / solved.length,
      tokensPerVerifiedPatch: solved.length ? totalTokens / solved.length : null,
      // Reports written before format retries existed have no count.
      formatErrors: sum(group.map((r) => r.formatErrors ?? 0)),
      editFailures: sum(group.map((r) => r.editFailures ?? 0)),
      repeatsDropped: sum(group.map((r) => r.repeatsDropped ?? 0)),
      repeatReplies: sum(group.map((r) => r.repeatReplies ?? 0)),
    };
  });
}

export async function compareRepair(options: ComparisonOptions): Promise<ComparisonReport> {
  const cache = options.cache === false ? undefined : new Map<string, TesseraVerificationRecord>();
  const runs: RepairRunReport[] = [];
  const shared = new Map<ComparisonArm["generator"], RecordedRounds>();
  const sharedGenerator = (arm: ComparisonArm, task: RepairTask, seed: number, original: string) => {
    const inner = arm.generator?.(seed, original);
    if (!inner || options.shareCandidates === false) return inner;
    let rounds = shared.get(arm.generator);
    if (!rounds) shared.set(arm.generator, (rounds = new RecordedRounds()));
    return rounds.wrap(`${task.name}\0${seed}`, inner);
  };
  for (const task of options.tasks) {
    const original = await readFile(join(task.dir, task.file), "utf8");
    for (const seed of options.seeds) {
      for (const arm of options.arms) {
        const report = await runRepair({
          task,
          tsr: options.tsr,
          arm: arm.name,
          seed,
          generator: sharedGenerator(arm, task, seed, original),
          decision: arm.decision(seed, original),
          maxRounds: options.maxRounds,
          candidatesPerRound: options.candidatesPerRound,
          pricing: options.pricing,
          cache,
          latticeDir: options.latticeDir,
          suggestions: options.suggestions,
          edits: options.edits,
          minimal: options.minimal,
          memory: options.memory,
          repeats: options.repeats,
        });
        runs.push(report);
        options.onRun?.(report);
      }
    }
  }
  return {
    schema: "lattice.tessera-comparison/v0",
    createdAt: new Date().toISOString(),
    tsr: runs.find((r) => r.tsr)?.tsr,
    seeds: options.seeds,
    maxRounds: options.maxRounds ?? 6,
    candidatesPerRound: options.candidatesPerRound ?? 4,
    suggestions: options.suggestions !== false,
    minimal: options.minimal ?? false,
    memoryEntries: options.memory?.length ?? 0,
    repeats: options.repeats ?? "canonical",
    runs,
    summary: summarize(runs),
  };
}

const fmt = (value: number | null, digits = 2) => (value === null ? "-" : value.toFixed(digits));

export function formatComparison(report: ComparisonReport): string {
  const lines = [
    report.suggestions
      ? "tsr suggestions: ON (compiler repairs tried before the generator; compare with --no-suggestions)"
      : "tsr suggestions: OFF (generator-only ablation)",
    "",
    "| task | arm | solved | by compiler repair | by generator | unresolved | mean rounds to solve | mean patch distance | model tokens / generator patch | model cost / generator patch (USD) | end-to-end tokens / verified patch | end-to-end cost / verified patch (USD) |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const s of report.summary) {
    lines.push(
      `| ${s.task} | ${s.arm} | ${s.solved}/${s.runs} | ${s.solvedByCompilerRepair} | ${s.solvedByModelGenerator} | ${s.unresolved} | ${fmt(s.meanRoundsToSolve)} | ${fmt(s.meanPatchDistance, 1)} | ${fmt(s.modelTokensPerModelPatch, 0)} | ${fmt(s.modelCostPerModelPatchUsd, 6)} | ${fmt(s.tokensPerVerifiedPatch, 0)} | ${fmt(s.costPerVerifiedPatchUsd, 6)} |`,
    );
  }
  return lines.join("\n");
}
