import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  hasObjectiveEvidence,
  loadLedger,
  type LedgerDecision,
  type LedgerFrame,
  type LedgerRun,
} from "@lattice/ledger";

export type PolicyAutonomyMode = "autopilot" | "supervised" | "manual";

export interface CandidatePolicy {
  autonomy?: {
    mode?: PolicyAutonomyMode;
    minConfidence?: number;
    maxNormalizedEntropy?: number;
    reviewHighCost?: boolean;
    reviewQuestionWarnings?: boolean;
  };
  search?: {
    maxRounds?: number;
    topK?: number;
    parallelism?: number;
  };
}

export interface PolicyMetrics {
  runs: number;
  verifiedSuccesses: number;
  decisionCalls: number;
  decisionTokens: number;
  recordedDecisionCostUsd: number;
  decisionLatencyMs: number;
  humanReviews: number;
  experiments: number;
}

export interface SplitSimulation {
  totalRuns: number;
  comparableRuns: number;
  unsupportedRuns: number;
  baseline: PolicyMetrics;
  candidate: PolicyMetrics;
  unsupportedReasons: Record<string, number>;
  unsupportedMetrics: string[];
}

export interface PolicySimulationReport {
  candidate: CandidatePolicy;
  holdoutFraction: number;
  train: SplitSimulation;
  holdout: SplitSimulation;
  warnings: string[];
}

interface SimulatedRun {
  supported: boolean;
  reason?: string;
  baseline: PolicyMetrics;
  candidate: PolicyMetrics;
  unsupportedMetrics: string[];
}

function emptyMetrics(): PolicyMetrics {
  return {
    runs: 0,
    verifiedSuccesses: 0,
    decisionCalls: 0,
    decisionTokens: 0,
    recordedDecisionCostUsd: 0,
    decisionLatencyMs: 0,
    humanReviews: 0,
    experiments: 0,
  };
}

function addMetrics(target: PolicyMetrics, source: PolicyMetrics): void {
  target.runs += source.runs;
  target.verifiedSuccesses += source.verifiedSuccesses;
  target.decisionCalls += source.decisionCalls;
  target.decisionTokens += source.decisionTokens;
  target.recordedDecisionCostUsd += source.recordedDecisionCostUsd;
  target.decisionLatencyMs += source.decisionLatencyMs;
  target.humanReviews += source.humanReviews;
  target.experiments += source.experiments;
}

function frameFor(
  run: LedgerRun,
  decision: LedgerDecision,
): LedgerFrame | undefined {
  if (decision.frameId) {
    const frame = run.frames.find((item) => item.id === decision.frameId);
    if (frame) return frame;
  }
  return run.frames.find((item) => item.round === decision.round);
}

function normalizedEntropy(
  entropy: number | undefined,
  choiceCount: number,
): number | undefined {
  if (entropy === undefined || choiceCount <= 1) return undefined;
  const max = Math.log(choiceCount);
  return max > 0 ? entropy / max : undefined;
}

function highCostSelected(
  frame: LedgerFrame | undefined,
  selected: string[],
): boolean | undefined {
  if (!frame) return undefined;
  return selected.some((id) => {
    const choice = frame.choices.find((item) => item.id === id);
    return /estimated cost:\s*high/i.test(choice?.detail ?? "");
  });
}

function candidateNeedsReview(
  policy: CandidatePolicy,
  frame: LedgerFrame | undefined,
  decision: LedgerDecision,
): { required: boolean; unsupportedReason?: string } {
  const mode = policy.autonomy?.mode ?? "autopilot";
  if (mode === "manual") return { required: true };
  if (mode === "autopilot") return { required: false };

  const minConfidence = policy.autonomy?.minConfidence ?? 0.72;
  if (
    decision.confidence !== undefined &&
    decision.confidence < minConfidence
  ) {
    return { required: true };
  }

  if (decision.entropy !== undefined) {
    if (!frame) {
      return {
        required: false,
        unsupportedReason:
          "supervised entropy policy requires missing decision frame",
      };
    }
    const nEntropy = normalizedEntropy(
      decision.entropy,
      Math.max(frame.choices.length, 2),
    );
    if (
      nEntropy !== undefined &&
      nEntropy > (policy.autonomy?.maxNormalizedEntropy ?? 0.72)
    ) {
      return { required: true };
    }
  }

  if (policy.autonomy?.reviewQuestionWarnings ?? true) {
    if (!frame) {
      return {
        required: false,
        unsupportedReason:
          "question-warning policy requires missing decision frame",
      };
    }
    if (frame.audit.some((item) => item.severity === "warning")) {
      return { required: true };
    }
  }

  if (policy.autonomy?.reviewHighCost ?? true) {
    const highCost = highCostSelected(frame, decision.selected);
    if (highCost === undefined) {
      return {
        required: false,
        unsupportedReason:
          "high-cost review policy requires missing decision frame",
      };
    }
    if (highCost) return { required: true };
  }

  return { required: false };
}

function actualReviews(run: LedgerRun, round: number) {
  return run.reviews.filter((item) => item.round === round);
}

function baselineMetrics(run: LedgerRun): PolicyMetrics {
  const metrics = emptyMetrics();
  metrics.runs = 1;
  metrics.decisionCalls = run.decisions.length;
  metrics.decisionTokens = run.decisions.reduce(
    (total, item) => total + (item.usage.totalTokens ?? 0),
    0,
  );
  metrics.recordedDecisionCostUsd = run.decisions.reduce(
    (total, item) => total + (item.usage.costUsd ?? 0),
    0,
  );
  metrics.decisionLatencyMs = run.decisions.reduce(
    (total, item) => total + item.usage.latencyMs,
    0,
  );
  metrics.humanReviews = new Set(run.reviews.map((item) => item.round)).size;
  metrics.experiments = run.experiments.length;
  metrics.verifiedSuccesses = run.experiments.some(
    (item) =>
      item.status === "success" &&
      item.terminal === true &&
      hasObjectiveEvidence(item.evidence),
  )
    ? 1
    : 0;
  return metrics;
}

function experimentsFor(
  run: LedgerRun,
  round: number,
  selected: string[],
): {
  supported: boolean;
  reason?: string;
  experiments: typeof run.experiments;
} {
  const roundExperiments = run.experiments.filter(
    (item) => item.round === round,
  );
  const picked = selected.map((id) =>
    roundExperiments.find((item) => item.candidateId === id),
  );
  if (picked.some((item) => !item)) {
    return {
      supported: false,
      reason:
        "candidate policy selects an action that was not executed in recorded history",
      experiments: [],
    };
  }
  return {
    supported: true,
    experiments: picked.filter(
      (item): item is (typeof run.experiments)[number] => Boolean(item),
    ),
  };
}

function simulateRun(run: LedgerRun, policy: CandidatePolicy): SimulatedRun {
  const baseline = baselineMetrics(run);
  const candidate = emptyMetrics();
  candidate.runs = 1;
  const unsupportedMetrics: string[] = [];

  if (
    policy.search?.parallelism !== undefined &&
    policy.search.parallelism !== 1
  ) {
    unsupportedMetrics.push(
      "execution latency under changed parallelism is not inferable from current ledger",
    );
  }

  const decisions = [...run.decisions].sort((a, b) => a.round - b.round);
  const observedMaxRound = Math.max(0, ...decisions.map((item) => item.round));
  const maxRounds = policy.search?.maxRounds ?? observedMaxRound;

  if (
    maxRounds > observedMaxRound &&
    baseline.verifiedSuccesses === 0
  ) {
    return {
      supported: false,
      reason:
        "candidate maxRounds exceeds recorded unsuccessful trajectory; extra rounds were never observed",
      baseline,
      candidate,
      unsupportedMetrics,
    };
  }

  for (const decision of decisions) {
    if (decision.round > maxRounds) break;

    candidate.decisionCalls += 1;
    candidate.decisionTokens += decision.usage.totalTokens ?? 0;
    candidate.recordedDecisionCostUsd += decision.usage.costUsd ?? 0;
    candidate.decisionLatencyMs += decision.usage.latencyMs;

    const frame = frameFor(run, decision);
    const reviewCheck = candidateNeedsReview(policy, frame, decision);
    if (reviewCheck.unsupportedReason) {
      return {
        supported: false,
        reason: reviewCheck.unsupportedReason,
        baseline,
        candidate,
        unsupportedMetrics,
      };
    }

    const reviews = actualReviews(run, decision.round);
    const lastReview = reviews.at(-1);

    let selected = [...decision.selected];

    if (reviewCheck.required) {
      candidate.humanReviews += 1;
      if (!lastReview) {
        return {
          supported: false,
          reason:
            "candidate policy would require human review that was not recorded",
          baseline,
          candidate,
          unsupportedMetrics,
        };
      }

      if (lastReview.action === "stop") {
        return {
          supported: true,
          baseline,
          candidate,
          unsupportedMetrics,
        };
      }

      if (lastReview.action === "refine") {
        continue;
      }

      if (
        lastReview.action === "replace" &&
        lastReview.selected?.length
      ) {
        selected = [...lastReview.selected];
      }
    } else if (
      lastReview &&
      (lastReview.action === "replace" ||
        lastReview.action === "refine" ||
        lastReview.action === "stop")
    ) {
      return {
        supported: false,
        reason:
          "candidate policy removes a behavior-changing recorded human review",
        baseline,
        candidate,
        unsupportedMetrics,
      };
    }

    selected = selected.filter((id) => id !== "__none__");
    if (!selected.length) {
      return {
        supported: true,
        baseline,
        candidate,
        unsupportedMetrics,
      };
    }

    const topK = Math.max(1, policy.search?.topK ?? selected.length);
    if (topK > selected.length) {
      return {
        supported: false,
        reason:
          "candidate topK requires additional unexecuted choices",
        baseline,
        candidate,
        unsupportedMetrics,
      };
    }
    selected = selected.slice(0, topK);

    const replay = experimentsFor(run, decision.round, selected);
    if (!replay.supported) {
      return {
        supported: false,
        reason: replay.reason,
        baseline,
        candidate,
        unsupportedMetrics,
      };
    }

    candidate.experiments += replay.experiments.length;

    const objective = replay.experiments.filter((item) =>
      hasObjectiveEvidence(item.evidence),
    );
    if (objective.length !== replay.experiments.length) {
      return {
        supported: false,
        reason:
          "selected recorded experiment lacks objective evidence needed for replay",
        baseline,
        candidate,
        unsupportedMetrics,
      };
    }

    if (
      objective.some(
        (item) => item.status === "success" && item.terminal === true,
      )
    ) {
      candidate.verifiedSuccesses = 1;
      return {
        supported: true,
        baseline,
        candidate,
        unsupportedMetrics,
      };
    }
  }

  return {
    supported: true,
    baseline,
    candidate,
    unsupportedMetrics,
  };
}

function stableFraction(runId: string): number {
  const hex = createHash("sha256").update(runId).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16) / 0xffffffff;
}

function simulateSplit(
  runs: LedgerRun[],
  policy: CandidatePolicy,
): SplitSimulation {
  const baseline = emptyMetrics();
  const candidate = emptyMetrics();
  const unsupportedReasons: Record<string, number> = {};
  const unsupportedMetrics = new Set<string>();
  let comparableRuns = 0;

  for (const run of runs) {
    const result = simulateRun(run, policy);
    for (const metric of result.unsupportedMetrics) {
      unsupportedMetrics.add(metric);
    }

    if (!result.supported) {
      const reason = result.reason ?? "unsupported counterfactual";
      unsupportedReasons[reason] = (unsupportedReasons[reason] ?? 0) + 1;
      continue;
    }

    comparableRuns += 1;
    addMetrics(baseline, result.baseline);
    addMetrics(candidate, result.candidate);
  }

  return {
    totalRuns: runs.length,
    comparableRuns,
    unsupportedRuns: runs.length - comparableRuns,
    baseline,
    candidate,
    unsupportedReasons,
    unsupportedMetrics: [...unsupportedMetrics].sort(),
  };
}

export function simulatePolicy(
  runs: LedgerRun[],
  policy: CandidatePolicy,
  holdoutFraction = 0.2,
): PolicySimulationReport {
  const fraction = Math.min(0.9, Math.max(0, holdoutFraction));
  const train: LedgerRun[] = [];
  const holdout: LedgerRun[] = [];

  for (const run of runs) {
    if (fraction > 0 && stableFraction(run.runId) < fraction) holdout.push(run);
    else train.push(run);
  }

  const warnings: string[] = [];
  if (!holdout.length && fraction > 0) {
    warnings.push(
      "Held-out split is empty; collect more runs or choose a different holdout fraction before policy promotion.",
    );
  }
  if (policy.search?.parallelism !== undefined) {
    warnings.push(
      "Changed parallelism can be replayed for selection/success only; execution-latency counterfactuals are unsupported until per-experiment timing is recorded.",
    );
  }

  return {
    candidate: policy,
    holdoutFraction: fraction,
    train: simulateSplit(train, policy),
    holdout: simulateSplit(holdout, policy),
    warnings,
  };
}

export async function loadCandidatePolicy(path: string): Promise<CandidatePolicy> {
  const raw = await readFile(resolve(path), "utf8");
  const parsed = JSON.parse(raw) as CandidatePolicy;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Candidate policy must be a JSON object");
  }
  return parsed;
}

export async function buildPolicySimulation(
  candidatePath: string,
  runPaths: string[],
  holdoutFraction = 0.2,
  cwd = process.cwd(),
): Promise<PolicySimulationReport> {
  const policy = await loadCandidatePolicy(resolve(cwd, candidatePath));
  const runs = await loadLedger(runPaths, cwd);
  return simulatePolicy(runs, policy, holdoutFraction);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function splitLines(name: string, split: SplitSimulation): string[] {
  const baselineRate = split.baseline.runs
    ? split.baseline.verifiedSuccesses / split.baseline.runs
    : 0;
  const candidateRate = split.candidate.runs
    ? split.candidate.verifiedSuccesses / split.candidate.runs
    : 0;

  return [
    `${name}: comparable ${split.comparableRuns}/${split.totalRuns}, unsupported ${split.unsupportedRuns}`,
    `  verified success: ${pct(baselineRate)} -> ${pct(candidateRate)}`,
    `  decision calls:   ${split.baseline.decisionCalls} -> ${split.candidate.decisionCalls}`,
    `  decision tokens:  ${split.baseline.decisionTokens} -> ${split.candidate.decisionTokens}`,
    `  human reviews:    ${split.baseline.humanReviews} -> ${split.candidate.humanReviews}`,
    `  experiments:      ${split.baseline.experiments} -> ${split.candidate.experiments}`,
    ...Object.entries(split.unsupportedReasons).map(
      ([reason, count]) => `  unsupported[${count}]: ${reason}`,
    ),
    ...split.unsupportedMetrics.map(
      (metric) => `  unsupported metric: ${metric}`,
    ),
  ];
}

export function formatPolicySimulation(
  report: PolicySimulationReport,
): string {
  return [
    `Lattice policy simulation (holdout ${pct(report.holdoutFraction)})`,
    "",
    ...splitLines("train", report.train),
    "",
    ...splitLines("holdout", report.holdout),
    ...(report.warnings.length
      ? ["", ...report.warnings.map((warning) => `warning: ${warning}`)]
      : []),
  ].join("\n");
}
