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
  /** Raw tool records (e.g. witness documents) kept verbatim in the run log for replay. */
  records?: unknown[];
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
  /** Internal provider operation; not a user-facing CLI command. */
  mode?: "choice" | "rank";
  /** Why this question was chosen for this TAP state. */
  routingReason?: ContextualQuestionRoute["reason"];
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
      identity?: ProviderIdentity;
      usage?: ProviderUsage;
    }
  | {
      /** The generator answered but its reply was unusable; the run stops. */
      type: "candidates.rejected";
      round: number;
      error: string;
      identity?: ProviderIdentity;
      usage?: ProviderUsage;
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
      /**
       * A deterministic policy replaced the model's selection. `decision.completed`
       * keeps what the model chose; this event records what ran and why, so
       * calibration and mining can tell a model choice from a policy choice.
       */
      type: "decision.overridden";
      round: number;
      frameId: string;
      modelSelected: string[];
      effectiveSelected: string[];
      selectedBy: "abstention-policy";
      reason: "verify-top";
      scores: Record<string, number>;
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

/**
 * Overrides the generic proposal prompt for domain-specific searches (e.g.
 * candidates that are whole replacement files). The JSON reply contract is
 * unchanged: `{"candidates":[{id,label,action,expectedEvidence,estimatedCost}]}`.
 */
export interface ProposalPrompt {
  system?: string;
  /** Receives the number of candidates requested this round. */
  prompt?: (count: number) => string;
  /** Extra context appended after the compact TAP state each round. */
  context?: (tap: TapPacket) => string[] | Promise<string[]>;
}

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
  proposal?: ProposalPrompt;
  /**
   * What to do when the decision layer selects none of the candidates.
   * "block" (default) ends the run; "verify-top" runs the highest-scoring
   * candidate anyway, because verification is what settles the question.
   * It only applies when at least one candidate has a positive score; with
   * all scores zero or absent there is no ranking to follow, so the run blocks.
   */
  onAbstain?: "block" | "verify-top";
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
  mode: "choice" | "rank" = "choice",
): string {
  const canonical = JSON.stringify({
    decisionClass,
    mode,
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

/**
 * Small, deterministic first slice of contextual question routing.
 * Only adjusts question framing, not permissions, authorization, or verification.
 * Textual intent signals from model-proposed actions are advisory.
 */
export interface ContextualQuestionRoute {
  class: DecisionClass;
  mode: "choice" | "rank";
  reason: "missing-evidence" | "investigation" | "patch-selection" | "mixed-actions";
  question: string;
  criteria: string[];
}

function actionFamily(action: string): "probe" | "edit" | "mixed" {
  const probe = /\b(inspect|reproduce|run|trace|read|search|test|measure|profile|benchmark|check|verify|locate|diagnose|investigate)\b/i.test(action);
  const edit = /\b(fix|patch|implement|edit|change|modify|replace|refactor|rewrite|update|write|add|remove)\b/i.test(action);
  return probe && !edit ? "probe" : edit && !probe ? "edit" : "mixed";
}

export function routeContextualQuestion(
  tap: TapPacket,
  candidates: CandidateAction[],
  topK = 1,
): ContextualQuestionRoute {
  const mode = topK > 1 ? "rank" : "choice";
  const grounded = tap.evidence.some((item) => item.verified);
  const families = candidates.map((candidate) => actionFamily(candidate.action));
  const allProbes = families.length > 0 && families.every((family) => family === "probe");
  const allEdits = families.length > 0 && families.every((family) => family === "edit");
  const suffix = "Use only the supplied evidence; select insufficient evidence / none if no candidate is justified.";

  if (!grounded) {
    return {
      class: allProbes ? "experiment" : "next-action",
      mode,
      reason: "missing-evidence",
      question: "Which proposed step best establishes reliable facts about the task before implementation? " + suffix,
      criteria: ["verified information gain", "likelihood of resolving the uncertainty", "execution cost", "reversibility"],
    };
  }
  if (allProbes) {
    return {
      class: "experiment",
      mode,
      reason: "investigation",
      question: "Which investigation should be attempted first to reduce the outstanding uncertainty? " + suffix,
      criteria: ["expected information gain", "existing verified facts", "execution cost", "reversibility"],
    };
  }
  if (allEdits) {
    return {
      class: "patch-selection",
      mode,
      reason: "patch-selection",
      question: "Which proposed patch should undergo independent verification first against the task constraints and current evidence? Model preference does not establish correctness. " + suffix,
      criteria: ["verified evidence", "task constraints", "risk of regression", "cost to verify", "reversibility"],
    };
  }
  return {
    class: "next-action",
    mode,
    reason: "mixed-actions",
    question: "Which next action best advances the task, balancing evidence collection against verified implementation progress? " + suffix,
    criteria: ["verified progress", "information gain", "execution cost", "risk", "reversibility"],
  };
}

export function compileDecisionFrame(
  tap: TapPacket,
  candidates: CandidateAction[],
  decisionClass: DecisionClass = "next-action",
  contextual?: ContextualQuestionRoute,
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
    contextual?.question ??
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
      message: "Decision state exceeds 16k characters; preserve mandatory evidence and retrieve originals before lossy compacting.",
    });
  }

  return {
    id: frameId(decisionClass, question, state, choices, contextual?.mode),
    class: decisionClass,
    mode: contextual?.mode ?? "choice",
    routingReason: contextual?.reason,
    objective: tap.task,
    question,
    criteria: contextual?.criteria ?? [
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
    const proposal = options.proposal;
    const generated = await options.generator.generate({
      system:
        proposal?.system ??
        "You are the proposal stage of an evidence-first coding search. Do not fabricate repository facts.",
      prompt: (proposal?.prompt ?? candidatePrompt)(candidatesPerRound),
      context: [state, ...((await proposal?.context?.(tap)) ?? [])],
      temperature: 0.3,
    });

    let candidates: CandidateAction[];
    try {
      candidates = parseCandidates(generated.text, candidatesPerRound);
    } catch (error) {
      // Record the call before failing so its tokens and cost are not lost.
      await options.onTrace?.({
        type: "candidates.rejected",
        round,
        error: error instanceof Error ? error.message : String(error),
        identity: generated.identity,
        usage: generated.usage,
      });
      throw error;
    }
    tap.candidateActions = candidates.map(
      (candidate) => `${candidate.id}:${candidate.label}`,
    );

    await options.onTrace?.({
      type: "candidates.generated",
      round,
      candidates,
      identity: generated.identity,
      usage: generated.usage,
    });

    const route = routeContextualQuestion(tap, candidates, topK);
    const frame = compileDecisionFrame(tap, candidates, route.class, route);
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
      mode: frame.mode,
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

    const score = (id: string) => decision.scores[id] ?? 0;
    if (
      selectedIds.length === 0 &&
      options.onAbstain === "verify-top" &&
      candidates.some((candidate) => score(candidate.id) > 0)
    ) {
      selectedIds = [...candidates]
        .sort((a, b) => score(b.id) - score(a.id))
        .slice(0, topK)
        .map((candidate) => candidate.id);
      selectedCandidates = selectedIds.map((id) => candidates.find((candidate) => candidate.id === id)!);
      await options.onTrace?.({
        type: "decision.overridden",
        round,
        frameId: frame.id,
        modelSelected: decision.selected,
        effectiveSelected: selectedIds,
        selectedBy: "abstention-policy",
        reason: "verify-top",
        scores: decision.scores,
      });
      tap.uncertainties.push(
        `round ${round}: decision layer selected none; verifying the top-scored candidate ${selectedIds.join(", ")} anyway`,
      );
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
