import { readFile, readdir, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type {
  DecisionChoice,
  EvidenceRef,
  ProviderIdentity,
  ProviderUsage,
  RunEvent,
} from "@lattice/protocol";

export interface LedgerFrame {
  round: number;
  id: string;
  decisionClass: string;
  objective?: string;
  question: string;
  criteria: string[];
  evidenceIds: string[];
  choices: DecisionChoice[];
  audit: Array<{
    severity?: string;
    code?: string;
    message?: string;
  }>;
}

export interface LedgerDecision {
  round: number;
  frameId?: string;
  decisionClass: string;
  question?: string;
  selected: string[];
  scores: Record<string, number>;
  confidence?: number;
  entropy?: number;
  identity: ProviderIdentity;
  usage: ProviderUsage;
}

export interface LedgerReview {
  round: number;
  frameId?: string;
  action?: string;
  selected?: string[];
  note?: string;
}

export interface LedgerExperiment {
  round: number;
  candidateId?: string;
  status?: string;
  terminal?: boolean;
  summary?: string;
  evidence: EvidenceRef[];
}

export interface LedgerRun {
  sourceFile: string;
  runId: string;
  task?: string;
  cwd?: string;
  repoRevision?: string;
  frames: LedgerFrame[];
  decisions: LedgerDecision[];
  reviews: LedgerReview[];
  experiments: LedgerExperiment[];
}

export interface ObjectiveOutcome {
  linked: boolean;
  success: boolean;
  experiments: LedgerExperiment[];
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

export function hasObjectiveEvidence(evidence: EvidenceRef[]): boolean {
  return evidence.some((item) => OBJECTIVE_KINDS.has(item.kind));
}

export function objectiveOutcome(
  run: LedgerRun,
  round: number,
): ObjectiveOutcome {
  const experiments = run.experiments.filter(
    (item) => item.round === round && hasObjectiveEvidence(item.evidence),
  );
  return {
    linked: experiments.length > 0,
    success: experiments.some(
      (item) => item.status === "success" && item.terminal === true,
    ),
    experiments,
  };
}

export function effectiveSelected(
  run: LedgerRun,
  decision: LedgerDecision,
): string[] {
  const reviews = run.reviews.filter((item) => item.round === decision.round);
  const replacement = [...reviews]
    .reverse()
    .find(
      (item) =>
        item.action === "replace" &&
        Array.isArray(item.selected) &&
        item.selected.length > 0,
    );
  return replacement?.selected ?? decision.selected;
}

export async function discoverLedgerFiles(
  paths: string[],
  cwd = process.cwd(),
): Promise<string[]> {
  const requested = paths.length
    ? paths.map((path) => resolve(cwd, path))
    : [resolve(cwd, ".lattice", "runs")];

  async function collect(path: string): Promise<string[]> {
    try {
      const info = await stat(path);
      if (info.isFile()) return extname(path) === ".jsonl" ? [path] : [];
      if (!info.isDirectory()) return [];
      const entries = await readdir(path, { withFileTypes: true });
      const nested = await Promise.all(
        entries.map((entry) => collect(resolve(path, entry.name))),
      );
      return nested.flat();
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }
  }

  return [...new Set((await Promise.all(requested.map(collect))).flat())].sort();
}

export async function readRunEvents(path: string): Promise<RunEvent[]> {
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

function parseFrame(payload: Record<string, unknown>): LedgerFrame | undefined {
  if (payload.type !== "decision.framed" || typeof payload.round !== "number") {
    return undefined;
  }
  const frame = asRecord(payload.frame);
  if (!frame || typeof frame.id !== "string" || typeof frame.question !== "string") {
    return undefined;
  }
  return {
    round: payload.round,
    id: frame.id,
    decisionClass:
      typeof frame.class === "string" ? frame.class : "unknown",
    objective:
      typeof frame.objective === "string" ? frame.objective : undefined,
    question: frame.question,
    criteria: Array.isArray(frame.criteria)
      ? frame.criteria.filter((item): item is string => typeof item === "string")
      : [],
    evidenceIds: Array.isArray(frame.evidenceIds)
      ? frame.evidenceIds.filter((item): item is string => typeof item === "string")
      : [],
    choices: Array.isArray(frame.choices)
      ? frame.choices
          .map((item) => asRecord(item))
          .filter((item): item is Record<string, unknown> => Boolean(item))
          .filter(
            (item) =>
              typeof item.id === "string" &&
              typeof item.label === "string",
          )
          .map((item) => ({
            id: item.id as string,
            label: item.label as string,
            detail:
              typeof item.detail === "string" ? item.detail : undefined,
          }))
      : [],
    audit: Array.isArray(frame.audit)
      ? frame.audit
          .map((item) => asRecord(item))
          .filter((item): item is Record<string, unknown> => Boolean(item))
          .map((item) => ({
            severity:
              typeof item.severity === "string" ? item.severity : undefined,
            code: typeof item.code === "string" ? item.code : undefined,
            message:
              typeof item.message === "string" ? item.message : undefined,
          }))
      : [],
  };
}

function parseDecision(payload: Record<string, unknown>): LedgerDecision | undefined {
  if (payload.type !== "decision.completed" || typeof payload.round !== "number") {
    return undefined;
  }
  const identity = asRecord(payload.identity);
  const usage = asRecord(payload.usage);
  if (!identity || typeof identity.provider !== "string") return undefined;

  const scoresRecord = asRecord(payload.scores) ?? {};
  const scores: Record<string, number> = {};
  for (const [key, value] of Object.entries(scoresRecord)) {
    const parsed = numberValue(value);
    if (parsed !== undefined) scores[key] = parsed;
  }

  return {
    round: payload.round,
    frameId:
      typeof payload.frameId === "string" ? payload.frameId : undefined,
    decisionClass:
      typeof payload.decisionClass === "string"
        ? payload.decisionClass
        : "unknown",
    question:
      typeof payload.question === "string" ? payload.question : undefined,
    selected: Array.isArray(payload.selected)
      ? payload.selected.filter((item): item is string => typeof item === "string")
      : [],
    scores,
    confidence: numberValue(payload.confidence),
    entropy: numberValue(payload.entropy),
    identity: {
      provider: identity.provider,
      model: typeof identity.model === "string" ? identity.model : undefined,
    },
    usage: {
      inputTokens: numberValue(usage?.inputTokens),
      outputTokens: numberValue(usage?.outputTokens),
      totalTokens: numberValue(usage?.totalTokens),
      costUsd: numberValue(usage?.costUsd),
      latencyMs: numberValue(usage?.latencyMs) ?? 0,
    },
  };
}

function parseReview(payload: Record<string, unknown>): LedgerReview | undefined {
  if (
    payload.type !== "decision.review.completed" ||
    typeof payload.round !== "number"
  ) {
    return undefined;
  }
  const result = asRecord(payload.result);
  return {
    round: payload.round,
    frameId:
      typeof payload.frameId === "string" ? payload.frameId : undefined,
    action:
      result && typeof result.action === "string"
        ? result.action
        : undefined,
    selected:
      result && Array.isArray(result.selected)
        ? result.selected.filter((item): item is string => typeof item === "string")
        : undefined,
    note:
      result && typeof result.note === "string"
        ? result.note
        : undefined,
  };
}

export async function loadLedger(
  paths: string[],
  cwd = process.cwd(),
): Promise<LedgerRun[]> {
  const files = await discoverLedgerFiles(paths, cwd);
  const runs: LedgerRun[] = [];

  for (const file of files) {
    const events = await readRunEvents(file);
    const runId = events[0]?.runId ?? file;
    const run: LedgerRun = {
      sourceFile: file,
      runId,
      frames: [],
      decisions: [],
      reviews: [],
      experiments: [],
    };

    for (const event of events) {
      const payload = asRecord(event.payload);
      if (!payload) continue;

      if (event.type === "run.started") {
        if (typeof payload.task === "string") run.task = payload.task;
        if (typeof payload.cwd === "string") run.cwd = payload.cwd;
      }

      if (event.type === "tap.created") {
        const repo = asRecord(payload.repo);
        if (repo && typeof repo.revision === "string") {
          run.repoRevision = repo.revision;
        }
      }

      if (event.type === "decision.requested") {
        const nested = asRecord(payload.event);
        if (nested) {
          const frame = parseFrame(nested);
          if (frame) run.frames.push(frame);
        }
      }

      if (event.type === "decision.completed") {
        const decision = parseDecision(payload);
        if (decision) run.decisions.push(decision);
        const review = parseReview(payload);
        if (review) run.reviews.push(review);
      }

      if (
        event.type === "tool.completed" &&
        payload.tool === "experiment" &&
        typeof payload.round === "number"
      ) {
        const outcome = asRecord(payload.outcome);
        if (outcome) {
          run.experiments.push({
            round: payload.round,
            candidateId:
              typeof outcome.candidateId === "string"
                ? outcome.candidateId
                : undefined,
            status:
              typeof outcome.status === "string" ? outcome.status : undefined,
            terminal:
              typeof outcome.terminal === "boolean"
                ? outcome.terminal
                : undefined,
            summary:
              typeof outcome.summary === "string" ? outcome.summary : undefined,
            evidence: Array.isArray(outcome.evidence)
              ? (outcome.evidence as EvidenceRef[])
              : [],
          });
        }
      }
    }

    runs.push(run);
  }

  return runs;
}
