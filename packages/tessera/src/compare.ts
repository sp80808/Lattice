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
  type RepairTask,
} from "./repair.js";
import type { TesseraVerificationRecord } from "./witness.js";

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
  onRun?: (report: RepairRunReport) => void;
}

export interface ArmSummary {
  task: string;
  arm: string;
  runs: number;
  solved: number;
  /** Means over solved runs; null when none solved. */
  meanRoundsToSolve: number | null;
  meanVerificationsToSolve: number | null;
  meanTokens: number;
  meanCostUsd: number | null;
  /** Cost of all runs divided by solved runs: what one verified patch costs. */
  costPerVerifiedPatchUsd: number | null;
  tokensPerVerifiedPatch: number | null;
}

export interface ComparisonReport {
  schema: "lattice.tessera-comparison/v0";
  createdAt: string;
  tsr?: { version: string; commit: string; dirty: boolean | null };
  seeds: number[];
  maxRounds: number;
  candidatesPerRound: number;
  runs: RepairRunReport[];
  summary: ArmSummary[];
}

const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

export function summarize(runs: RepairRunReport[]): ArmSummary[] {
  const groups = new Map<string, RepairRunReport[]>();
  for (const run of runs) {
    const key = `${run.task}\0${run.arm}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.values()].map((group) => {
    const solved = group.filter((r) => r.status === "solved");
    const costs = group.map((r) => r.costUsd);
    const totalCost = costs.includes(null) ? null : (costs as number[]).reduce((a, b) => a + b, 0);
    const totalTokens = group.reduce((a, r) => a + r.tokens, 0);
    return {
      task: group[0]!.task,
      arm: group[0]!.arm,
      runs: group.length,
      solved: solved.length,
      meanRoundsToSolve: mean(solved.map((r) => r.rounds)),
      meanVerificationsToSolve: mean(solved.map((r) => r.verifications)),
      meanTokens: totalTokens / group.length,
      meanCostUsd: totalCost === null ? null : totalCost / group.length,
      costPerVerifiedPatchUsd:
        totalCost === null || solved.length === 0 ? null : totalCost / solved.length,
      tokensPerVerifiedPatch: solved.length ? totalTokens / solved.length : null,
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
    runs,
    summary: summarize(runs),
  };
}

const fmt = (value: number | null, digits = 2) => (value === null ? "-" : value.toFixed(digits));

export function formatComparison(report: ComparisonReport): string {
  const lines = [
    "| task | arm | solved | mean rounds to solve | mean tsr verifications to solve | tokens / verified patch | cost / verified patch (USD) |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const s of report.summary) {
    lines.push(
      `| ${s.task} | ${s.arm} | ${s.solved}/${s.runs} | ${fmt(s.meanRoundsToSolve)} | ${fmt(s.meanVerificationsToSolve)} | ${fmt(s.tokensPerVerifiedPatch, 0)} | ${fmt(s.costPerVerifiedPatchUsd, 6)} |`,
    );
  }
  return lines.join("\n");
}
