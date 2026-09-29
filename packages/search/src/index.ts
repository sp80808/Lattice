import { createHash } from "node:crypto";
import {
  UNKNOWN_CHOICE_ID,
  type DecisionChoice,
  type DecisionProvider,
  type DecisionResult,
  type EvidenceRef,
  type GeneratorProvider,
  type ProviderIdentity,
  type ProviderUsage,
  type TapPacket,
} from "@lattice/protocol";

export type CandidateCost = "low" | "medium" | "high";
export type DecisionClass =
  | "next-action"
  | "hypothesis"
  | "experiment"
  | "patch-selection"
  | "verification"
  | "routing";

export interface CandidateAction {
  id: string;
  label: string;
  action: string;
  expectedEvidence: string;
  estimatedCost?: CandidateCost;
}

export interface ExperimentOutcome {
  candidateId: string;
  status: "success" | "failure" | "inconclusive";
  terminal: boolean;
  summary: string;
  evidence: EvidenceRef[];
  uncertainties?: string[];
}

export interface ExperimentExecutor {
  execute(
    candidate: CandidateAction,
    tap: TapPacket,
  ): Promise<ExperimentOutcome>;
}

export interface QuestionAuditFinding {
  severity: "error" | "warning";
  code:
    | "no-verified-evidence"
    | "too-many-choices"
    | "similar-options"
    | "leading-option"
    | "state-too-large"
    | "missing-unknown";
  message: string;
}

export interface DecisionFrame {
  id: string;
  class: DecisionClass;
  objective: string;
  question: string;
  criteria: string[];
  state: string;
  evidenceIds: string[];
  choices: DecisionChoice[];
  allowUnknown: boolean;
  audit: QuestionAuditFinding[];
}

export type AutonomyMode = "autopilot" | "supervised" | "manual";

export interface AutonomyPolicy {
  mode?: AutonomyMode;
  minConfidence?: number;
  maxNormalizedEntropy?: number;
  reviewHighCost?: boolean;
  reviewQuestionWarnings?: boolean;
}

export interface DecisionReviewRequest {
  round: number;
  frame: DecisionFrame;
  decision: DecisionResult;
  selectedCandidates: CandidateAction[];
  reasons: string[];
}

export type DecisionReviewResult =
  | { action: "approve"; note?: string }
  | { action: "replace"; selected: string[]; note?: string }
  | { action: "refine"; note?: string }
  | { action: "stop"; note?: string };

export type DecisionReviewer = (
  request: DecisionReviewRequest,
) => Promise<DecisionReviewResult>;

export type SearchTraceEvent =
  | {
      type: "candidates.generated";
      round: number;
      candidates: CandidateAction[];
    }
  | {
      type: "decision.framed";
      round: number;
      frame: DecisionFrame;
    }
  | {
      type: "decision.completed";
      round: number;
      frameId: string;
      decisionClass: DecisionClass;
      question: string;
      selected: string[];
      scores: Record<string, number>;
      confidence?: number;
      entropy?: number;
      identity: ProviderIdentity;
      usage: ProviderUsage;
    }
  | {
      type: "decision.review.requested";
      round: number;
      frameId: string;
      reasons: string[];
      selected: string[];
    }
  | {
      type: "decision.review.completed";
      round: number;
      frameId: string;
      result: DecisionReviewResult;
    }
  | {
      type: "experiment.started";
      round: number;
      candidate: CandidateAction;
    }
  | {
      type: "experiment.completed";
      round: number;
      outcome: ExperimentOutcome;
    };

export interface SearchLoopOptions {
  tap: TapPacket;
  generator: GeneratorProvider;
  decision: DecisionProvider;
  executor: ExperimentExecutor;
  maxRounds?: number;
  candidatesPerRound?: number;
  topK?: number;
  parallelism?: number;
  autonomy?: AutonomyPolicy;
  reviewer?: DecisionReviewer;
  onTrace?: (event: SearchTraceEvent) => void | Promise<void>;
}

export interface SearchLoopResult {
  status: "solved" | "blocked" | "budget_exhausted";
  rounds: number;
  tap: TapPacket;
  selected: string[];
}

interface CandidateEnvelope {
  candidates?: CandidateAction[];
}

function jsonObject(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last < first) {
    throw new Error("Candidate generator returned no JSON object");
  }
  return JSON.parse(trimmed.slice(first, last + 1));
}

function parseCandidates(text: string, limit: number): CandidateAction[] {
  const parsed = jsonObject(text) as CandidateEnvelope;
  if (!Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
    throw new Error("Candidate generator returned no candidates");
  }

  const result: CandidateAction[] = [];
  const ids = new Set<string>();

  for (const raw of parsed.candidates.slice(0, limit)) {
    if (
      !raw ||
      typeof raw.id !== "string" ||
      typeof raw.label !== "string" ||
      typeof raw.action !== "string" ||
      typeof raw.expectedEvidence !== "string"
    ) {
      throw new Error("Candidate generator returned an invalid candidate");
    }

    const id = raw.id.trim();
    if (!id || id === UNKNOWN_CHOICE_ID || ids.has(id)) {
      throw new Error(`Invalid or duplicate candidate ID: ${id || "<empty>"}`);
    }
    ids.add(id);

    result.push({
      id,
      label: raw.label.trim(),
      action: raw.action.trim(),
      expectedEvidence: raw.expectedEvidence.trim(),
      estimatedCost:
        raw.estimatedCost === "low" ||
        raw.estimatedCost === "medium" ||
        raw.estimatedCost === "high"
          ? raw.estimatedCost
          : undefined,
    });
  }

  return result;
}

function compactState(tap: TapPacket): string {
  const evidence = tap.evidence
    .slice(-12)
    .map(
      (item) =>
        `${item.id}:${item.kind}:${item.verified ? "verified" : "unverified"}:${item.summary}`,
    )
    .join("\n");

  return [
    `OBJECTIVE:${tap.task}`,
    tap.constraints.length ? `CONSTRAINTS:${tap.constraints.join(" | ")}` : "CONSTRAINTS:none",
    evidence ? `EVIDENCE:\n${evidence}` : "EVIDENCE:none",
    tap.uncertainties.length
      ? `UNCERTAINTIES:${tap.uncertainties.join(" | ")}`
      : "UNCERTAINTIES:none",
  ].join("\n");
}

function candidatePrompt(count: number): string {
  return [
    `Propose up to ${count} genuinely distinct next actions for the coding task.`,
    "Each action must be grounded in supplied evidence or explicitly gather missing evidence.",
    "Do not encode a preferred answer in option wording.",
    "Prefer cheap discriminating experiments before expensive edits.",
    "State the concrete evidence each action is expected to produce.",
    "Return JSON only:",
    '{"candidates":[{"id":"a","label":"short neutral label","action":"what to do","expectedEvidence":"what result would teach us","estimatedCost":"low|medium|high"}]}',
  ].join("\n");
}

function normalizedWords(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3),
  );
}

function overlap(a: string, b: string): number {
  const left = normalizedWords(a);
  const right = normalizedWords(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

function frameId(
  decisionClass: DecisionClass,
  question: string,
  state: string,
  choices: DecisionChoice[],
): string {
  const canonical = JSON.stringify({
    decisionClass,
    question,
    state,
    choices: choices.map((choice) => ({
      id: choice.id,
      label: choice.label,
      detail: choice.detail ?? "",
    })),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 20);
}

export function compileDecisionFrame(
  tap: TapPacket,
  candidates: CandidateAction[],
  decisionClass: DecisionClass = "next-action",
): DecisionFrame {
  const allowUnknown = true;
  const choices: DecisionChoice[] = candidates.map((candidate) => ({
    id: candidate.id,
    label: candidate.label,
    detail: [
      `action: ${candidate.action}`,
      `expected evidence: ${candidate.expectedEvidence}`,
      candidate.estimatedCost ? `estimated cost: ${candidate.estimatedCost}` : undefined,
    ]
      .filter(Boolean)
      .join(" | "),
  }));

  choices.push({
    id: UNKNOWN_CHOICE_ID,
    label: "Insufficient evidence / none of these",
    detail:
      "Select when the supplied evidence does not justify any option or the option set is materially incomplete.",
  });

  const question =
    "Rank the available next actions by expected verified progress per unit cost and risk, using only the supplied evidence. Do not assume any candidate hypothesis is true.";

  const state = compactState(tap);
  const audit: QuestionAuditFinding[] = [];

  if (!tap.evidence.some((item) => item.verified)) {
    audit.push({
      severity: "warning",
      code: "no-verified-evidence",
      message: "No verified evidence is present in the decision frame.",
    });
  }

  if (choices.length > 9) {
    audit.push({
      severity: "warning",
      code: "too-many-choices",
      message: "Decision has more than eight substantive options plus unknown.",
    });
  }

  if (!choices.some((choice) => choice.id === UNKNOWN_CHOICE_ID)) {
    audit.push({
      severity: "error",
      code: "missing-unknown",
      message: "Decision frame must contain an explicit unknown/none option.",
    });
  }

  for (let i = 0; i < candidates.length; i++) {
    const current = candidates[i]!;
    if (/\b(obvious|obviously|clearly|best|correct|preferred)\b/i.test(current.label)) {
      audit.push({
        severity: "warning",
        code: "leading-option",
        message: `Option ${current.id} contains potentially leading wording.`,
      });
    }

    for (let j = i + 1; j < candidates.length; j++) {
      const other = candidates[j]!;
      if (overlap(current.action, other.action) >= 0.8) {
        audit.push({
          severity: "warning",
          code: "similar-options",
          message: `Options ${current.id} and ${other.id} may not be meaningfully distinct.`,
        });
      }
    }
  }

  if (state.length > 16_000) {
    audit.push({
      severity: "warning",
      code: "state-too-large",
      message: "Decision state exceeds 16k characters and should be compressed.",
    });
  }

  return {
    id: frameId(decisionClass, question, state, choices),
    class: decisionClass,
    objective: tap.task,
    question,
    criteria: [
      "expected verified progress",
      "information gain",
      "execution cost",
      "regression/risk exposure",
      "reversibility",
    ],
    state,
    evidenceIds: tap.evidence.slice(-12).map((item) => item.id),
    choices,
    allowUnknown,
    audit,
  };
}

function normalizedEntropy(
  entropy: number | undefined,
  choiceCount: number,
): number | undefined {
  if (entropy === undefined || choiceCount <= 1) return undefined;
  const max = Math.log(choiceCount);
  return max > 0 ? entropy / max : undefined;
}

function reviewReasons(
  policy: AutonomyPolicy,
  frame: DecisionFrame,
  decision: DecisionResult,
  selectedCandidates: CandidateAction[],
): string[] {
  const mode = policy.mode ?? "autopilot";
  if (mode === "manual") return ["manual mode reviews every model decision"];
  if (mode === "autopilot") return [];

  const reasons: string[] = [];
  if (
    decision.selected.length === 0 ||
    decision.selected[0] === UNKNOWN_CHOICE_ID
  ) {
    reasons.push("decision model selected insufficient evidence / none");
  }
  const minConfidence = policy.minConfidence ?? 0.72;
  if (
    decision.confidence !== undefined &&
    decision.confidence < minConfidence
  ) {
    reasons.push(
      `confidence ${decision.confidence.toFixed(3)} below ${minConfidence.toFixed(3)}`,
    );
  }

  const nEntropy = normalizedEntropy(decision.entropy, frame.choices.length);
  const maxEntropy = policy.maxNormalizedEntropy ?? 0.72;
  if (nEntropy !== undefined && nEntropy > maxEntropy) {
    reasons.push(
      `normalized entropy ${nEntropy.toFixed(3)} above ${maxEntropy.toFixed(3)}`,
    );
  }

  if (
    (policy.reviewQuestionWarnings ?? true) &&
    frame.audit.some((finding) => finding.severity === "warning")
  ) {
    reasons.push("question framing audit emitted warnings");
  }

  if (
    (policy.reviewHighCost ?? true) &&
    selectedCandidates.some((candidate) => candidate.estimatedCost === "high")
  ) {
    reasons.push("selected action is estimated high cost");
  }

  return reasons;
}

async function runLimited<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        await fn(items[index]!);
      }
    },
  );
  await Promise.all(workers);
}

export async function runSearchLoop(
  options: SearchLoopOptions,
): Promise<SearchLoopResult> {
  const tap = structuredClone(options.tap);
  const maxRounds = options.maxRounds ?? tap.budget.maxRounds ?? 4;
  const candidatesPerRound = Math.max(
    2,
    Math.min(options.candidatesPerRound ?? 5, 12),
  );
  const topK = Math.max(1, Math.min(options.topK ?? 1, candidatesPerRound));
  const parallelism = Math.max(1, Math.min(options.parallelism ?? topK, topK));
  const autonomy = options.autonomy ?? { mode: "autopilot" };
  const selected: string[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const state = compactState(tap);
    const generated = await options.generator.generate({
      system:
        "You are the proposal stage of an evidence-first coding search. Do not fabricate repository facts.",
      prompt: candidatePrompt(candidatesPerRound),
      context: [state],
      temperature: 0.3,
    });

    const candidates = parseCandidates(generated.text, candidatesPerRound);
    tap.candidateActions = candidates.map(
      (candidate) => `${candidate.id}:${candidate.label}`,
    );

    await options.onTrace?.({
      type: "candidates.generated",
      round,
      candidates,
    });

    const frame = compileDecisionFrame(tap, candidates, "next-action");
    await options.onTrace?.({
      type: "decision.framed",
      round,
      frame,
    });

    const framingErrors = frame.audit.filter(
      (finding) => finding.severity === "error",
    );
    if (framingErrors.length) {
      tap.uncertainties.push(
        ...framingErrors.map(
          (finding) => `round ${round} framing error: ${finding.message}`,
        ),
      );
      return { status: "blocked", rounds: round, tap, selected };
    }

    const decision = await options.decision.decide({
      state: [
        frame.state,
        `DECISION_CRITERIA:${frame.criteria.join(" | ")}`,
        `EVIDENCE_HANDLES:${frame.evidenceIds.join(",") || "none"}`,
      ].join("\n"),
      question: frame.question,
      mode: topK > 1 ? "rank" : "choice",
      allowUnknown: frame.allowUnknown,
      choices: frame.choices.filter((choice) => choice.id !== UNKNOWN_CHOICE_ID),
    });

    await options.onTrace?.({
      type: "decision.completed",
      round,
      frameId: frame.id,
      decisionClass: frame.class,
      question: frame.question,
      selected: decision.selected,
      scores: decision.scores,
      confidence: decision.confidence,
      entropy: decision.entropy,
      identity: decision.identity,
      usage: decision.usage,
    });

    let selectedIds = decision.selected
      .filter((id) => id !== UNKNOWN_CHOICE_ID)
      .filter((id, index, all) => all.indexOf(id) === index)
      .slice(0, topK);

    let selectedCandidates = selectedIds
      .map((id) => candidates.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is CandidateAction => Boolean(candidate));

    if (selectedCandidates.length !== selectedIds.length) {
      throw new Error("Decision selected a candidate that was not generated");
    }

    const reasons = reviewReasons(
      autonomy,
      frame,
      decision,
      selectedCandidates,
    );

    if (reasons.length) {
      await options.onTrace?.({
        type: "decision.review.requested",
        round,
        frameId: frame.id,
        reasons,
        selected: selectedIds,
      });

      if (!options.reviewer) {
        tap.uncertainties.push(
          `round ${round}: human review required but no reviewer is available (${reasons.join("; ")})`,
        );
        return { status: "blocked", rounds: round, tap, selected };
      }

      const review = await options.reviewer({
        round,
        frame,
        decision,
        selectedCandidates,
        reasons,
      });

      await options.onTrace?.({
        type: "decision.review.completed",
        round,
        frameId: frame.id,
        result: review,
      });

      if (review.action === "stop") {
        tap.uncertainties.push(
          `round ${round}: human stopped decision${review.note ? `: ${review.note}` : ""}`,
        );
        return { status: "blocked", rounds: round, tap, selected };
      }

      if (review.action === "refine") {
        tap.context.push(
          `r${round}:human-refine:${review.note ?? "refine candidate framing/options"}`,
        );
        continue;
      }

      if (review.action === "replace") {
        const replacement = review.selected
          .filter((id, index, all) => all.indexOf(id) === index)
          .slice(0, topK);
        if (
          replacement.length === 0 ||
          replacement.some(
            (id) => !candidates.some((candidate) => candidate.id === id),
          )
        ) {
          throw new Error("Human reviewer selected an unavailable candidate");
        }
        selectedIds = replacement;
        selectedCandidates = selectedIds.map(
          (id) => candidates.find((candidate) => candidate.id === id)!,
        );
      }

      if (review.note) {
        tap.context.push(`r${round}:human-review:${review.note}`);
      }
    }

    if (selectedIds.length === 0) {
      tap.uncertainties.push(
        `round ${round}: decision layer could not justify any candidate`,
      );
      return { status: "blocked", rounds: round, tap, selected };
    }

    selected.push(...selectedIds);

    const outcomes: Array<ExperimentOutcome | undefined> = new Array(
      selectedCandidates.length,
    );

    await runLimited(
      selectedCandidates.map((candidate, index) => ({ candidate, index })),
      parallelism,
      async ({ candidate, index }) => {
        await options.onTrace?.({
          type: "experiment.started",
          round,
          candidate,
        });

        const outcome = await options.executor.execute(candidate, tap);
        if (outcome.candidateId !== candidate.id) {
          throw new Error(
            `Experiment outcome candidate mismatch: expected ${candidate.id}, got ${outcome.candidateId}`,
          );
        }
        outcomes[index] = outcome;

        await options.onTrace?.({
          type: "experiment.completed",
          round,
          outcome,
        });
      },
    );

    let solved = false;
    for (const outcome of outcomes) {
      if (!outcome) continue;
      tap.evidence.push(...outcome.evidence);
      tap.context.push(`r${round}:${outcome.status}:${outcome.summary}`);
      if (outcome.uncertainties?.length) {
        tap.uncertainties.push(...outcome.uncertainties);
      }
      if (outcome.status === "success" && outcome.terminal) solved = true;
    }

    if (solved) {
      return { status: "solved", rounds: round, tap, selected };
    }
  }

  tap.uncertainties.push("search round budget exhausted");
  return {
    status: "budget_exhausted",
    rounds: maxRounds,
    tap,
    selected,
  };
}
