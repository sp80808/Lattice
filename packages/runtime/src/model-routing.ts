import type {
  DecisionProvider,
  GeneratorProvider,
  GeneratorRequest,
  GeneratorResult,
  ProviderUsage,
} from "@lattice/protocol";

/**
 * Explicitly configured candidates only. Availability/usage figures are snapshots,
 * NOT magically discovered subscription quotas. Router state is scoped to one run.
 */
export interface RoutingCandidate {
  id: string;
  provider: GeneratorProvider;
  maxTokens: number;
  maxContextTokens?: number;
  available?: boolean;
  remainingRequests?: number;
  remainingTokens?: number;
  remainingCostUsd?: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  verifiedSuccessRate?: number;
  verifiedSamples?: number;
  priority?: number;
}

interface CandidateState {
  requests?: number;
  tokens?: number;
  usd?: number;
  disabled: boolean;
}

export function estimatedInputTokens(request: GeneratorRequest): number {
  const chars = (request.system?.length ?? 0) + request.prompt.length +
    (request.context ?? []).reduce((total, fragment) => total + fragment.length, 0);
  // Conservative-ish eligibility estimate, NOT a tokenizer or hard usage bound.
  return Math.ceil(chars / 3) + 64;
}

function knownUsageTokens(usage: ProviderUsage): number | undefined {
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    return usage.inputTokens + usage.outputTokens;
  }
  return undefined;
}

function plusKnown(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined || b === undefined ? undefined : a + b;
}

function combineUsage(main: ProviderUsage, selector: ProviderUsage[]): ProviderUsage {
  if (!selector.length) return main;
  return selector.reduce<ProviderUsage>((combined, call) => ({
    inputTokens: plusKnown(combined.inputTokens, call.inputTokens),
    outputTokens: plusKnown(combined.outputTokens, call.outputTokens),
    totalTokens: plusKnown(combined.totalTokens, call.totalTokens),
    costUsd: plusKnown(combined.costUsd, call.costUsd),
    latencyMs: combined.latencyMs + call.latencyMs,
  }), main);
}

function availabilityFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:Provider request failed:\s*(?:401|402|403|408|409|429|500|502|503|504)\b|\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed)\b)/i.test(message);
}

/**
 * Decision-model-assisted routing. Deterministic eligibility is checked before
 * and after selection; a model cannot introduce an endpoint or override limits.
 */
export class DecisionRoutedGenerator implements GeneratorProvider {
  private readonly states = new Map<string, CandidateState>();

  constructor(
    private readonly candidates: RoutingCandidate[],
    private readonly selector: DecisionProvider,
  ) {
    if (!candidates.length) throw new Error("Generator pool must not be empty");
    for (const candidate of candidates) {
      if (!candidate.id.trim() || this.states.has(candidate.id)) {
        throw new Error("Generator pool IDs must be unique and non-empty");
      }
      if (!Number.isSafeInteger(candidate.maxTokens) || candidate.maxTokens <= 0) {
        throw new Error("Generator pool maxTokens must be a positive integer");
      }
      this.states.set(candidate.id, {
        requests: candidate.remainingRequests,
        tokens: candidate.remainingTokens,
        usd: candidate.remainingCostUsd,
        disabled: candidate.available === false,
      });
    }
  }

  private estimatedCost(candidate: RoutingCandidate, inputTokens: number): number | undefined {
    if (candidate.inputUsdPerMillion === undefined ||
        candidate.outputUsdPerMillion === undefined) return undefined;
    return (inputTokens * candidate.inputUsdPerMillion +
      candidate.maxTokens * candidate.outputUsdPerMillion) / 1_000_000;
  }

  private eligible(candidate: RoutingCandidate, inputTokens: number): boolean {
    const state = this.states.get(candidate.id)!;
    if (state.disabled || (state.requests !== undefined && state.requests < 1)) return false;
    const estimatedTokens = inputTokens + candidate.maxTokens;
    if (candidate.maxContextTokens !== undefined && estimatedTokens > candidate.maxContextTokens) return false;
    if (state.tokens !== undefined && estimatedTokens > state.tokens) return false;
    if (state.usd !== undefined) {
      const estimatedUsd = this.estimatedCost(candidate, inputTokens);
      if (estimatedUsd === undefined || estimatedUsd > state.usd) return false;
    }
    return true;
  }

  async generate(request: GeneratorRequest): Promise<GeneratorResult> {
    const inputTokens = estimatedInputTokens(request);
    const attempted: string[] = [];
    const selectorUsage: ProviderUsage[] = [];
    let selectorIdentity: GeneratorResult["identity"] | undefined;
    let selectionMode: "decision-model" | "sole-eligible" = "sole-eligible";

    while (attempted.length < this.candidates.length) {
      const eligible = this.candidates.filter(
        (item) => !attempted.includes(item.id) && this.eligible(item, inputTokens),
      );
      if (!eligible.length) {
        throw new Error(
          "No eligible generator model remains (availability, context, usage or cost limit); " +
          "check configured snapshots and provider status. Attempted: " + attempted.join(", "),
        );
      }

      let selected = eligible[0]!;
      if (eligible.length > 1) {
        selectionMode = "decision-model";
        const response = await this.selector.decide({
          question: "Choose the best eligible generator for this coding proposal: prioritize " +
            "independently verified task success, sufficient context, and success per cost/latency. " +
            "Prefer cheaper models when capability is sufficient; abstain if evidence is inadequate.",
          state: JSON.stringify({
            taskPreview: request.prompt.slice(0, 900),
            estimatedInputTokens: inputTokens,
            choices: eligible.map((item) => ({
              id: item.id,
              model: item.id,
              maxContextTokens: item.maxContextTokens ?? null,
              maxOutputTokens: item.maxTokens,
              remainingRequests: this.states.get(item.id)!.requests ?? null,
              remainingTokens: this.states.get(item.id)!.tokens ?? null,
              remainingCostUsd: this.states.get(item.id)!.usd ?? null,
              estimatedMaxCostUsd: this.estimatedCost(item, inputTokens) ?? null,
              verifiedSuccessRate: (item.verifiedSamples ?? 0) >= 20
                ? item.verifiedSuccessRate ?? null : null,
              verifiedSamples: item.verifiedSamples ?? 0,
              priority: item.priority ?? 0,
            })),
          }),
          choices: eligible.map((item) => ({
            id: item.id,
            label: item.id,
            detail: "Configured candidate; see state for availability and verified metrics",
          })),
          mode: "choice",
          allowUnknown: true,
        });
        selectorUsage.push(response.usage);
        selectorIdentity = response.identity;
        const choice = response.selected[0];
        if (response.selected.length !== 1 || choice === "__none__") {
          throw new Error("Model selector abstained; no generator was called");
        }
        const match = eligible.find((item) => item.id === choice);
        if (!match) throw new Error("Model selector chose an ineligible generator");
        selected = match;
      }

      attempted.push(selected.id);
      const state = this.states.get(selected.id)!;
      if (state.requests !== undefined) state.requests -= 1; // reserve before dispatch

      try {
        const result = await selected.provider.generate(request);
        if (state.tokens !== undefined) {
          const used = knownUsageTokens(result.usage);
          if (used === undefined || !Number.isFinite(used) || used < 0) state.disabled = true;
          else state.tokens -= used;
        }
        if (state.usd !== undefined) {
          let cost = result.usage.costUsd;
          if (cost === undefined &&
              result.usage.inputTokens !== undefined &&
              result.usage.outputTokens !== undefined &&
              selected.inputUsdPerMillion !== undefined &&
              selected.outputUsdPerMillion !== undefined) {
            cost = (result.usage.inputTokens * selected.inputUsdPerMillion +
              result.usage.outputTokens * selected.outputUsdPerMillion) / 1_000_000;
          }
          if (cost === undefined || !Number.isFinite(cost) || cost < 0) state.disabled = true;
          else state.usd -= cost;
        }

        return {
          ...result,
          usage: combineUsage(result.usage, selectorUsage),
          routing: {
            selected: selected.id,
            attempted,
            eligible: eligible.map((item) => item.id),
            selectionMode,
            estimatedInputTokens: inputTokens,
            selectorIdentity,
            selectorUsage: selectorUsage.length ? selectorUsage : undefined,
          },
        };
      } catch (error) {
        if (!availabilityFailure(error)) throw error;
        state.disabled = true; // provider-specific failure: retry a different eligible endpoint
      }
    }
    throw new Error("No available generator model could complete the request");
  }
}
