import {
  loadLedger,
  objectiveOutcome,
  type LedgerDecision,
} from "@lattice/ledger";

export interface CalibrationBucket {
  lower: number;
  upper: number;
  decisions: number;
  labelled: number;
  successes: number;
  successRate?: number;
}

export interface StatsGroup {
  decisionClass: string;
  provider: string;
  model?: string;
  decisions: number;
  outcomeLinked: number;
  verifiedSuccesses: number;
  verifiedFailures: number;
  unknownOutcomes: number;
  verifiedSuccessRate?: number;
  humanReviews: number;
  humanOverrides: number;
  humanRefinements: number;
  totalTokens: number;
  totalCostUsd: number;
  totalLatencyMs: number;
  meanLatencyMs?: number;
  meanConfidence?: number;
  calibration: CalibrationBucket[];
}

export interface StatsReport {
  files: number;
  runs: number;
  decisions: number;
  outcomeLinked: number;
  unknownOutcomes: number;
  groups: StatsGroup[];
  warnings: string[];
}

function bucketIndex(confidence: number): number {
  return Math.min(9, Math.max(0, Math.floor(confidence * 10)));
}

function emptyCalibration(): CalibrationBucket[] {
  return Array.from({ length: 10 }, (_, index) => ({
    lower: index / 10,
    upper: (index + 1) / 10,
    decisions: 0,
    labelled: 0,
    successes: 0,
  }));
}

interface MutableGroup extends StatsGroup {
  confidenceSum: number;
  confidenceCount: number;
}

function groupKey(decision: LedgerDecision): string {
  return [
    decision.decisionClass,
    decision.identity.provider,
    decision.identity.model ?? "",
  ].join("\0");
}

export async function buildStatsReport(
  paths: string[],
  cwd = process.cwd(),
): Promise<StatsReport> {
  const runs = await loadLedger(paths, cwd);
  const groups = new Map<string, MutableGroup>();
  const warnings: string[] = [];
  let decisionsTotal = 0;
  let linkedTotal = 0;

  for (const run of runs) {
    for (const decision of run.decisions) {
      decisionsTotal += 1;
      const key = groupKey(decision);
      let group = groups.get(key);
      if (!group) {
        group = {
          decisionClass: decision.decisionClass,
          provider: decision.identity.provider,
          model: decision.identity.model,
          decisions: 0,
          outcomeLinked: 0,
          verifiedSuccesses: 0,
          verifiedFailures: 0,
          unknownOutcomes: 0,
          humanReviews: 0,
          humanOverrides: 0,
          humanRefinements: 0,
          totalTokens: 0,
          totalCostUsd: 0,
          totalLatencyMs: 0,
          calibration: emptyCalibration(),
          confidenceSum: 0,
          confidenceCount: 0,
        };
        groups.set(key, group);
      }

      group.decisions += 1;
      group.totalTokens += decision.usage.totalTokens ?? 0;
      group.totalCostUsd += decision.usage.costUsd ?? 0;
      group.totalLatencyMs += decision.usage.latencyMs ?? 0;

      if (decision.confidence !== undefined) {
        group.confidenceSum += decision.confidence;
        group.confidenceCount += 1;
        group.calibration[bucketIndex(decision.confidence)]!.decisions += 1;
      }

      const reviews = run.reviews.filter(
        (item) => item.round === decision.round,
      );
      if (reviews.length) {
        group.humanReviews += 1;
        if (reviews.some((item) => item.action === "replace")) {
          group.humanOverrides += 1;
        }
        if (reviews.some((item) => item.action === "refine")) {
          group.humanRefinements += 1;
        }
      }

      const outcome = objectiveOutcome(run, decision.round);
      if (outcome.linked) {
        linkedTotal += 1;
        group.outcomeLinked += 1;
        if (outcome.success) group.verifiedSuccesses += 1;
        else group.verifiedFailures += 1;

        if (decision.confidence !== undefined) {
          const bucket = group.calibration[bucketIndex(decision.confidence)]!;
          bucket.labelled += 1;
          if (outcome.success) bucket.successes += 1;
        }
      } else {
        group.unknownOutcomes += 1;
      }
    }
  }

  const finalGroups: StatsGroup[] = [...groups.values()]
    .map((group) => {
      const { confidenceSum, confidenceCount, ...clean } = group;
      clean.verifiedSuccessRate = clean.outcomeLinked
        ? clean.verifiedSuccesses / clean.outcomeLinked
        : undefined;
      clean.meanLatencyMs = clean.decisions
        ? clean.totalLatencyMs / clean.decisions
        : undefined;
      clean.meanConfidence = confidenceCount
        ? confidenceSum / confidenceCount
        : undefined;
      for (const bucket of clean.calibration) {
        bucket.successRate = bucket.labelled
          ? bucket.successes / bucket.labelled
          : undefined;
      }
      return clean;
    })
    .sort(
      (a, b) =>
        a.decisionClass.localeCompare(b.decisionClass) ||
        a.provider.localeCompare(b.provider) ||
        (a.model ?? "").localeCompare(b.model ?? ""),
    );

  if (linkedTotal < decisionsTotal) {
    warnings.push(
      `${decisionsTotal - linkedTotal} decision(s) have no objective downstream outcome and are excluded from success-rate denominators.`,
    );
  }

  return {
    files: runs.length,
    runs: runs.length,
    decisions: decisionsTotal,
    outcomeLinked: linkedTotal,
    unknownOutcomes: decisionsTotal - linkedTotal,
    groups: finalGroups,
    warnings,
  };
}

function pct(value: number | undefined): string {
  return value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function num(value: number | undefined, digits = 1): string {
  return value === undefined ? "—" : value.toFixed(digits);
}

export function formatStatsReport(report: StatsReport): string {
  const rows = [[
    "class", "provider/model", "dec", "linked", "success",
    "tokens", "cost", "lat(ms)", "human", "override",
  ]];

  for (const group of report.groups) {
    rows.push([
      group.decisionClass,
      [group.provider, group.model].filter(Boolean).join("/") || "unknown",
      String(group.decisions),
      String(group.outcomeLinked),
      pct(group.verifiedSuccessRate),
      String(group.totalTokens),
      group.totalCostUsd ? group.totalCostUsd.toFixed(4) : "—",
      num(group.meanLatencyMs, 0),
      String(group.humanReviews),
      String(group.humanOverrides),
    ]);
  }

  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => row[column]!.length)),
  );
  const table = rows
    .map((row, index) => {
      const line = row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join("  ");
      if (index === 0) {
        return line + "\n" +
          widths.map((width) => "-".repeat(width)).join("  ");
      }
      return line;
    })
    .join("\n");

  const header =
    `Lattice stats: ${report.decisions} decision(s), ` +
    `${report.outcomeLinked} objectively linked, ${report.runs} run(s), ${report.files} file(s)`;

  return [
    header,
    "",
    table,
    ...(report.warnings.length
      ? ["", ...report.warnings.map((warning) => `warning: ${warning}`)]
      : []),
  ].join("\n");
}
