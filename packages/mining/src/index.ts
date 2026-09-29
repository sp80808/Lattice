import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  effectiveSelected,
  loadLedger,
  objectiveOutcome,
  type LedgerDecision,
  type LedgerFrame,
  type LedgerRun,
} from "@lattice/ledger";

export interface MiningEvidenceRef {
  runId: string;
  round: number;
  frameId?: string;
  sourceFile: string;
}

export interface RuleProposal {
  id: string;
  state: "inferred";
  signature: string;
  decisionClass: string;
  question: string;
  optionLabels: string[];
  action: {
    selectLabel: string;
  };
  support: number;
  successes: number;
  verifiedSuccessRate: number;
  dominantSelectionShare: number;
  evidence: MiningEvidenceRef[];
  promotion: {
    automatic: false;
    requiresHeldOutReplay: true;
    requiresReview: true;
  };
}

export interface ContextTileProposal {
  id: string;
  state: "inferred";
  kind: "failure-fix";
  scope: {
    tasks: string[];
    repoRevisions: string[];
  };
  condition: {
    failedDecisionClass: string;
    failedChoiceLabel: string;
  };
  avoid: string;
  prefer: string;
  why: string;
  support: number;
  evidence: Array<{
    runId: string;
    failedRound: number;
    successRound: number;
    sourceFile: string;
  }>;
  freshness: {
    verifiedAt: string;
    expiresAt?: string;
  };
  promotion: {
    automatic: false;
    requiresReproduction: true;
    requiresReview: true;
  };
}

export interface MiningOptions {
  maxRules?: number;
  maxTiles?: number;
  minRuleSupport?: number;
  minRuleSuccessRate?: number;
  minDominantShare?: number;
}

export interface MiningReport {
  generatedAt: string;
  runsScanned: number;
  decisionsScanned: number;
  rules: RuleProposal[];
  tiles: ContextTileProposal[];
  warnings: string[];
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function frameFor(
  run: LedgerRun,
  decision: LedgerDecision,
): LedgerFrame | undefined {
  if (decision.frameId) {
    const byId = run.frames.find((frame) => frame.id === decision.frameId);
    if (byId) return byId;
  }
  return run.frames.find((frame) => frame.round === decision.round);
}

function selectedChoice(
  run: LedgerRun,
  decision: LedgerDecision,
): { label: string; detail?: string } | undefined {
  const selected = effectiveSelected(run, decision)[0];
  if (!selected) return undefined;
  const frame = frameFor(run, decision);
  const choice = frame?.choices.find((item) => item.id === selected);
  if (choice) return { label: choice.label, detail: choice.detail };
  return { label: selected };
}

interface SelectionStats {
  support: number;
  successes: number;
  evidence: MiningEvidenceRef[];
}

interface RuleAccumulator {
  signature: string;
  decisionClass: string;
  question: string;
  optionLabels: string[];
  support: number;
  successes: number;
  selections: Map<string, SelectionStats>;
}

function mineRules(
  runs: LedgerRun[],
  options: Required<Pick<
    MiningOptions,
    "maxRules" | "minRuleSupport" | "minRuleSuccessRate" | "minDominantShare"
  >>,
): RuleProposal[] {
  const groups = new Map<string, RuleAccumulator>();

  for (const run of runs) {
    for (const decision of run.decisions) {
      const outcome = objectiveOutcome(run, decision.round);
      if (!outcome.linked) continue;
      const frame = frameFor(run, decision);
      const choice = selectedChoice(run, decision);
      if (!frame || !choice) continue;

      const optionLabels = frame.choices
        .filter((item) => item.id !== "__none__")
        .map((item) => normalize(item.label))
        .filter(Boolean)
        .sort();

      const signature = [
        decision.decisionClass,
        normalize(frame.question),
        optionLabels.join("|"),
      ].join("::");

      let group = groups.get(signature);
      if (!group) {
        group = {
          signature,
          decisionClass: decision.decisionClass,
          question: frame.question,
          optionLabels,
          support: 0,
          successes: 0,
          selections: new Map(),
        };
        groups.set(signature, group);
      }

      group.support += 1;
      if (outcome.success) group.successes += 1;

      let selection = group.selections.get(choice.label);
      if (!selection) {
        selection = { support: 0, successes: 0, evidence: [] };
        group.selections.set(choice.label, selection);
      }
      selection.support += 1;
      if (outcome.success) selection.successes += 1;
      selection.evidence.push({
        runId: run.runId,
        round: decision.round,
        frameId: decision.frameId,
        sourceFile: run.sourceFile,
      });
    }
  }

  const proposals: RuleProposal[] = [];
  for (const group of groups.values()) {
    const totalSuccessfulSelections = [...group.selections.values()].reduce(
      (total, selection) => total + selection.successes,
      0,
    );
    if (totalSuccessfulSelections === 0) continue;

    const rankedSelections = [...group.selections.entries()]
      .map(([label, stats]) => ({
        label,
        ...stats,
        successRate: stats.support ? stats.successes / stats.support : 0,
        successShare: stats.successes / totalSuccessfulSelections,
      }))
      .filter(
        (selection) =>
          selection.support >= options.minRuleSupport &&
          selection.successRate >= options.minRuleSuccessRate &&
          selection.successShare >= options.minDominantShare,
      )
      .sort(
        (a, b) =>
          b.successes - a.successes ||
          b.successRate - a.successRate ||
          a.label.localeCompare(b.label),
      );

    const dominant = rankedSelections[0];
    if (!dominant) continue;

    proposals.push({
      id: `rule:${hash(`${group.signature}::${normalize(dominant.label)}`)}`,
      state: "inferred",
      signature: group.signature,
      decisionClass: group.decisionClass,
      question: group.question,
      optionLabels: group.optionLabels,
      action: { selectLabel: dominant.label },
      support: dominant.support,
      successes: dominant.successes,
      verifiedSuccessRate: dominant.successRate,
      dominantSelectionShare: dominant.successShare,
      evidence: dominant.evidence.slice(0, 50),
      promotion: {
        automatic: false,
        requiresHeldOutReplay: true,
        requiresReview: true,
      },
    });
  }

  return proposals
    .sort(
      (a, b) =>
        b.support * b.verifiedSuccessRate * b.dominantSelectionShare -
          a.support * a.verifiedSuccessRate * a.dominantSelectionShare ||
        a.id.localeCompare(b.id),
    )
    .slice(0, options.maxRules);
}

interface TileAccumulator {
  signature: string;
  tasks: Set<string>;
  revisions: Set<string>;
  failedDecisionClass: string;
  failedChoiceLabel: string;
  avoid: string;
  prefer: string;
  evidence: ContextTileProposal["evidence"];
}

function mineTiles(
  runs: LedgerRun[],
  maxTiles: number,
  generatedAt: string,
): ContextTileProposal[] {
  const groups = new Map<string, TileAccumulator>();

  for (const run of runs) {
    const ordered = [...run.decisions].sort((a, b) => a.round - b.round);
    for (let i = 0; i < ordered.length; i++) {
      const failed = ordered[i]!;
      const failedOutcome = objectiveOutcome(run, failed.round);
      if (!failedOutcome.linked || failedOutcome.success) continue;

      const success = ordered
        .slice(i + 1)
        .find((decision) => {
          const outcome = objectiveOutcome(run, decision.round);
          return outcome.linked && outcome.success;
        });
      if (!success) continue;

      const failedChoice = selectedChoice(run, failed);
      const successChoice = selectedChoice(run, success);
      if (!failedChoice || !successChoice) continue;

      const avoid = failedChoice.detail ?? failedChoice.label;
      const prefer = successChoice.detail ?? successChoice.label;
      const signature = [
        failed.decisionClass,
        normalize(failedChoice.label),
        success.decisionClass,
        normalize(successChoice.label),
      ].join("::");

      let group = groups.get(signature);
      if (!group) {
        group = {
          signature,
          tasks: new Set(),
          revisions: new Set(),
          failedDecisionClass: failed.decisionClass,
          failedChoiceLabel: failedChoice.label,
          avoid,
          prefer,
          evidence: [],
        };
        groups.set(signature, group);
      }

      if (run.task) group.tasks.add(run.task);
      if (run.repoRevision) group.revisions.add(run.repoRevision);
      group.evidence.push({
        runId: run.runId,
        failedRound: failed.round,
        successRound: success.round,
        sourceFile: run.sourceFile,
      });
    }
  }

  return [...groups.values()]
    .map((group): ContextTileProposal => ({
      id: `tile:${hash(group.signature)}`,
      state: "inferred",
      kind: "failure-fix",
      scope: {
        tasks: [...group.tasks].sort(),
        repoRevisions: [...group.revisions].sort(),
      },
      condition: {
        failedDecisionClass: group.failedDecisionClass,
        failedChoiceLabel: group.failedChoiceLabel,
      },
      avoid: group.avoid,
      prefer: group.prefer,
      why:
        "Observed objective failure followed by later objective verified success in the same run. This is a memory candidate, not a causal proof.",
      support: group.evidence.length,
      evidence: group.evidence.slice(0, 50),
      freshness: {
        verifiedAt: generatedAt,
      },
      promotion: {
        automatic: false,
        requiresReproduction: true,
        requiresReview: true,
      },
    }))
    .sort((a, b) => b.support - a.support || a.id.localeCompare(b.id))
    .slice(0, maxTiles);
}

export async function mineLedger(
  paths: string[],
  options: MiningOptions = {},
  cwd = process.cwd(),
): Promise<MiningReport> {
  const runs = await loadLedger(paths, cwd);
  const generatedAt = new Date().toISOString();
  const resolved = {
    maxRules: Math.max(0, options.maxRules ?? 5),
    maxTiles: Math.max(0, options.maxTiles ?? 5),
    minRuleSupport: Math.max(2, options.minRuleSupport ?? 3),
    minRuleSuccessRate: Math.min(
      1,
      Math.max(0, options.minRuleSuccessRate ?? 0.95),
    ),
    minDominantShare: Math.min(
      1,
      Math.max(0, options.minDominantShare ?? 0.9),
    ),
  };

  const rules = mineRules(runs, resolved);
  const tiles = mineTiles(runs, resolved.maxTiles, generatedAt);
  const warnings: string[] = [];

  if (!rules.length) {
    warnings.push(
      "No deterministic-rule candidates met the current support/stability thresholds.",
    );
  }
  if (!tiles.length) {
    warnings.push(
      "No objective failure→later-success sequences were available for tile proposals.",
    );
  }

  return {
    generatedAt,
    runsScanned: runs.length,
    decisionsScanned: runs.reduce(
      (total, run) => total + run.decisions.length,
      0,
    ),
    rules,
    tiles,
    warnings,
  };
}

export async function writeMiningProposals(
  report: MiningReport,
  outputDir: string,
  cwd = process.cwd(),
): Promise<string[]> {
  const dir = resolve(cwd, outputDir);
  await mkdir(dir, { recursive: true });

  const files = [
    ["rules.proposed.json", report.rules],
    ["tiles.proposed.json", report.tiles],
    ["mining-report.json", report],
  ] as const;

  for (const [name, value] of files) {
    await writeFile(
      resolve(dir, name),
      JSON.stringify(value, null, 2) + "\n",
      "utf8",
    );
  }

  return files.map(([name]) => resolve(dir, name));
}

export function formatMiningReport(report: MiningReport): string {
  return [
    `Lattice mining: ${report.runsScanned} run(s), ${report.decisionsScanned} decision(s)`,
    `rule proposals: ${report.rules.length}`,
    `CTX tile proposals: ${report.tiles.length}`,
    ...report.rules.map(
      (rule) =>
        `  rule ${rule.id} support=${rule.support} success=${(rule.verifiedSuccessRate * 100).toFixed(1)}% dominant=${(rule.dominantSelectionShare * 100).toFixed(1)}% -> ${rule.action.selectLabel}`,
    ),
    ...report.tiles.map(
      (tile) =>
        `  tile ${tile.id} support=${tile.support} avoid="${tile.avoid.slice(0, 60)}" prefer="${tile.prefer.slice(0, 60)}"`,
    ),
    ...report.warnings.map((warning) => `warning: ${warning}`),
  ].join("\n");
}
