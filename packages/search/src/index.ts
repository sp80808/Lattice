import {
  UNKNOWN_CHOICE_ID,
  type DecisionProvider,
  type EvidenceRef,
  type GeneratorProvider,
  type TapPacket,
} from "@lattice/protocol";

export type CandidateCost = "low" | "medium" | "high";

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

export type SearchTraceEvent =
  | {
      type: "candidates.generated";
      round: number;
      candidates: CandidateAction[];
    }
  | {
      type: "decision.completed";
      round: number;
      selected: string[];
      confidence?: number;
      entropy?: number;
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
    .replace(/^\`\`\`(?:json)?\s*/i, "")
    .replace(/\s*\`\`\`$/, "");
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
        `${item.id}:${item.kind}:${item.verified ? "v" : "u"}:${item.summary}`,
    )
    .join("\n");

  return [
    `T:${tap.task}`,
    tap.constraints.length ? `C:${tap.constraints.join(" | ")}` : "",
    evidence ? `E:\n${evidence}` : "E:none",
    tap.uncertainties.length
      ? `U:${tap.uncertainties.join(" | ")}`
      : "U:none",
  ]
    .filter(Boolean)
    .join("\n");
}

function candidatePrompt(count: number): string {
  return [
    `Propose up to ${count} distinct next actions for the coding task.`,
    "Actions should gather evidence or make bounded progress, not assert unverified facts.",
    "Prefer cheap discriminating experiments before expensive edits.",
    "Return JSON only:",
    '{"candidates":[{"id":"a","label":"short label","action":"what to do","expectedEvidence":"what result would teach us","estimatedCost":"low|medium|high"}]}',
  ].join("\n");
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

    const candidates = parseCandidates(
      generated.text,
      candidatesPerRound,
    );
    tap.candidateActions = candidates.map(
      (candidate) => `${candidate.id}:${candidate.label}`,
    );

    await options.onTrace?.({
      type: "candidates.generated",
      round,
      candidates,
    });

    const decision = await options.decision.decide({
      state,
      question:
        "Which next action offers the best expected progress or information for its cost and risk?",
      mode: "choice",
      allowUnknown: true,
      choices: candidates.map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        detail: [
          candidate.action,
          `expected evidence: ${candidate.expectedEvidence}`,
          candidate.estimatedCost
            ? `cost: ${candidate.estimatedCost}`
            : undefined,
        ]
          .filter(Boolean)
          .join(" | "),
      })),
    });

    await options.onTrace?.({
      type: "decision.completed",
      round,
      selected: decision.selected,
      confidence: decision.confidence,
      entropy: decision.entropy,
    });

    const chosenId = decision.selected[0];
    if (!chosenId || chosenId === UNKNOWN_CHOICE_ID) {
      tap.uncertainties.push(
        `round ${round}: decision layer could not justify any candidate`,
      );
      return { status: "blocked", rounds: round, tap, selected };
    }

    const candidate = candidates.find((item) => item.id === chosenId);
    if (!candidate) {
      throw new Error(`Decision selected unavailable candidate: ${chosenId}`);
    }
    selected.push(chosenId);

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

    tap.evidence.push(...outcome.evidence);
    tap.context.push(`r${round}:${outcome.status}:${outcome.summary}`);
    if (outcome.uncertainties?.length) {
      tap.uncertainties.push(...outcome.uncertainties);
    }

    await options.onTrace?.({
      type: "experiment.completed",
      round,
      outcome,
    });

    if (outcome.status === "success" && outcome.terminal) {
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
