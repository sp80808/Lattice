import { readFile, readdir, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { EvidenceRef, RunEvent } from "@lattice/protocol";

interface LoggedDecision {
  runId: string;
  round: number;
  frameId?: string;
  decisionClass: string;
  provider: string;
  model?: string;
  confidence?: number;
  entropy?: number;
  tokens?: number;
  costUsd?: number;
  latencyMs?: number;
}

interface LoggedReview {
  round: number;
  action?: string;
}

interface LoggedOutcome {
  round: number;
  outcome: {
    status?: string;
    terminal?: boolean;
    evidence?: EvidenceRef[];
  };
}

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

const OBJECTIVE_KINDS = new Set([
  "command",
  "test",
  "build",
  "lint",
  "benchmark",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

async function collectJsonl(path: string): Promise<string[]> {
  const resolved = resolve(path);
  const info = await stat(resolved);
  if (info.isFile()) return extname(resolved) === ".jsonl" ? [resolved] : [];
  if (!info.isDirectory()) return [];

  const entries = await readdir(resolved, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      collectJsonl(resolve(resolved, entry.name)).catch(() => []),
    ),
  );
  return nested.flat().sort();
}

async function parseEvents(path: string): Promise<RunEvent[]> {
  const raw = await readFile(path, "utf8");
  const events: RunEvent[] = [];

  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as RunEvent);
    } catch (error) {
      throw new Error(
        `Invalid JSONL in ${path} line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return events;
}

function objectiveEvidence(evidence: unknown): boolean {
  if (!Array.isArray(evidence)) return false;
  return evidence.some((item) => {
    const record = asRecord(item);
    return record && typeof record.kind === "string" &&
      OBJECTIVE_KINDS.has(record.kind);
  });
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

function groupKey(decision: LoggedDecision): string {
  return [
    decision.decisionClass,
    decision.provider,
    decision.model ?? "",
  ].join("\0");
}

export async function buildStatsReport(
  paths: string[],
  cwd = process.cwd(),
): Promise<StatsReport> {
  const requested = paths.length ? paths : [resolve(cwd, ".lattice", "runs")];
  const fileLists = await Promise.all(
    requested.map((path) =>
      collectJsonl(resolve(cwd, path)).catch((error) => {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          return [];
        }
        throw error;
      }),
    ),
  );
  const files = [...new Set(fileLists.flat())].sort();

  const groups = new Map<string, MutableGroup>();
  const runIds = new Set<string>();
  const warnings: string[] = [];
  let decisionsTotal = 0;
  let linkedTotal = 0;

  for (const file of files) {
    const events = await parseEvents(file);
    const decisions: LoggedDecision[] = [];
    const reviews = new Map<number, LoggedReview[]>();
    const outcomes = new Map<number, LoggedOutcome[]>();

    for (const event of events) {
      runIds.add(event.runId);
      const payload = asRecord(event.payload);

      if (event.type === "decision.completed" && payload) {
        if (payload.type === "decision.completed") {
          const identity = asRecord(payload.identity);
          const usage = asRecord(payload.usage);
          if (
            typeof payload.round === "number" &&
            identity &&
            typeof identity.provider === "string"
          ) {
            decisions.push({
              runId: event.runId,
              round: payload.round,
              frameId:
                typeof payload.frameId === "string"
                  ? payload.frameId
                  : undefined,
              decisionClass:
                typeof payload.decisionClass === "string"
                  ? payload.decisionClass
                  : "unknown",
              provider: identity.provider,
              model:
                typeof identity.model === "string"
                  ? identity.model
                  : undefined,
              confidence: numberValue(payload.confidence),
              entropy: numberValue(payload.entropy),
              tokens: numberValue(usage?.totalTokens),
              costUsd: numberValue(usage?.costUsd),
              latencyMs: numberValue(usage?.latencyMs),
            });
          }
        } else if (
          payload.type === "decision.review.completed" &&
          typeof payload.round === "number"
        ) {
          const result = asRecord(payload.result);
          const list = reviews.get(payload.round) ?? [];
          list.push({
            round: payload.round,
            action:
              result && typeof result.action === "string"
                ? result.action
                : undefined,
          });
          reviews.set(payload.round, list);
        }
      }

      if (
        event.type === "tool.completed" &&
        payload?.tool === "experiment" &&
        typeof payload.round === "number"
      ) {
        const outcome = asRecord(payload.outcome);
        if (outcome) {
          const list = outcomes.get(payload.round) ?? [];
          list.push({
            round: payload.round,
            outcome: {
              status:
                typeof outcome.status === "string"
                  ? outcome.status
                  : undefined,
              terminal:
                typeof outcome.terminal === "boolean"
                  ? outcome.terminal
                  : undefined,
              evidence: Array.isArray(outcome.evidence)
                ? (outcome.evidence as EvidenceRef[])
                : undefined,
            },
          });
          outcomes.set(payload.round, list);
        }
      }
    }

    for (const decision of decisions) {
      decisionsTotal += 1;
      const key = groupKey(decision);
      let group = groups.get(key);
      if (!group) {
        group = {
          decisionClass: decision.decisionClass,
          provider: decision.provider,
          model: decision.model,
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
      group.totalTokens += decision.tokens ?? 0;
      group.totalCostUsd += decision.costUsd ?? 0;
      group.totalLatencyMs += decision.latencyMs ?? 0;

      if (decision.confidence !== undefined) {
        group.confidenceSum += decision.confidence;
        group.confidenceCount += 1;
        group.calibration[bucketIndex(decision.confidence)]!.decisions += 1;
      }

      const roundReviews = reviews.get(decision.round) ?? [];
      if (roundReviews.length) {
        group.humanReviews += 1;
        if (roundReviews.some((review) => review.action === "replace")) {
          group.humanOverrides += 1;
        }
        if (roundReviews.some((review) => review.action === "refine")) {
          group.humanRefinements += 1;
        }
      }

      const roundOutcomes = outcomes.get(decision.round) ?? [];
      const objective = roundOutcomes.filter((item) =>
        objectiveEvidence(item.outcome.evidence),
      );
      const linked = objective.length > 0;
      const success = objective.some(
        (item) =>
          item.outcome.status === "success" &&
          item.outcome.terminal === true,
      );

      if (linked) {
        linkedTotal += 1;
        group.outcomeLinked += 1;
        if (success) group.verifiedSuccesses += 1;
        else group.verifiedFailures += 1;

        if (decision.confidence !== undefined) {
          const bucket = group.calibration[bucketIndex(decision.confidence)]!;
          bucket.labelled += 1;
          if (success) bucket.successes += 1;
        }
      } else {
        group.unknownOutcomes += 1;
      }
    }
  }

  const finalGroups: StatsGroup[] = [...groups.values()]
    .map((group) => {
      const {
        confidenceSum,
        confidenceCount,
        ...clean
      } = group;
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
    files: files.length,
    runs: runIds.size,
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
  const rows = [
    [
      "class",
      "provider/model",
      "dec",
      "linked",
      "success",
      "tokens",
      "cost",
      "lat(ms)",
      "human",
      "override",
    ],
  ];

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
        return (
          line +
          "\n" +
          widths.map((width) => "-".repeat(width)).join("  ")
        );
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
