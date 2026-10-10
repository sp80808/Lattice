import {
  UNKNOWN_CHOICE_ID,
  type DecisionChoice,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResult,
  type GeneratorProvider,
  type GeneratorRequest,
  type GeneratorResult,
  type ProviderUsage,
} from "@lattice/protocol";

type FetchLike = typeof fetch;

export interface OpenAICompatibleConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Sent as `max_tokens`. Some routers reserve the model's full output limit against your balance when it is unset. */
  maxTokens?: number;
  jsonMode?: boolean;
  fetchImpl?: FetchLike;
  providerName?: string;
  /** Transient-failure retry policy. Default: 2 attempts, 250ms base, 4s cap. */
  retry?: RetryPolicy;
}

export interface RetryPolicy {
  /** Total attempts including the first call. 1 disables retries. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_RETRY: Required<RetryPolicy> = { attempts: 2, baseDelayMs: 250, maxDelayMs: 4_000 };

/** An HTTP error from the provider, carrying the status so callers can classify it. */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

/**
 * Transient failures worth another attempt: rate limits, server-side faults and
 * network-level fetch failures. Timeouts and 4xx client errors are the caller's
 * (or the request's) fault and retrying them only doubles latency.
 */
function isTransient(error: unknown): boolean {
  if (error instanceof ProviderHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  // fetch rejects with TypeError on connection reset/refused/DNS errors.
  return error instanceof TypeError;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** USD, when the endpoint reports it (OpenRouter, the Claude Code bridge). */
    cost?: number;
  };
}

interface DecisionEnvelope {
  selected?: string | string[];
  scores?: Record<string, number>;
  confidence?: number;
}

function endpoint(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "") + "/chat/completions";
}

function headers(apiKey?: string): Record<string, string> {
  const result: Record<string, string> = {
    "content-type": "application/json",
  };
  if (apiKey) result.authorization = `Bearer ${apiKey}`;
  return result;
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^\`\`\`(?:json)?\s*/i, "")
    .replace(/\s*\`\`\`$/, "");

  const first = unfenced.indexOf("{");
  const last = unfenced.lastIndexOf("}");
  if (first === -1 || last < first) {
    throw new Error("Decision provider returned no JSON object");
  }
  return JSON.parse(unfenced.slice(first, last + 1));
}

function finiteNonNegative(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function normalizeScores(
  choiceIds: string[],
  raw: Record<string, number> | undefined,
): Record<string, number> {
  const values: Record<string, number> = {};
  let sum = 0;

  for (const id of choiceIds) {
    const value = finiteNonNegative(raw?.[id]) ?? 0;
    values[id] = value;
    sum += value;
  }

  if (sum <= 0) return values;

  for (const id of choiceIds) values[id] /= sum;
  return values;
}

function entropy(scores: Record<string, number>): number | undefined {
  const probabilities = Object.values(scores).filter((value) => value > 0);
  if (probabilities.length === 0) return undefined;
  return -probabilities.reduce((total, p) => total + p * Math.log(p), 0);
}

function ensureChoices(request: DecisionRequest): DecisionChoice[] {
  if (request.choices.length < 1) {
    throw new Error("Decision request requires at least one choice");
  }

  const ids = new Set<string>();
  for (const choice of request.choices) {
    if (!choice.id.trim()) throw new Error("Decision choice IDs must not be empty");
    if (ids.has(choice.id)) throw new Error(`Duplicate decision choice ID: ${choice.id}`);
    ids.add(choice.id);
  }

  const choices = [...request.choices];
  if (request.allowUnknown !== false && !ids.has(UNKNOWN_CHOICE_ID)) {
    choices.push({
      id: UNKNOWN_CHOICE_ID,
      label: "Unknown / none of these",
      detail: "Choose this when the evidence is insufficient or all supplied choices are wrong.",
    });
  }
  return choices;
}

async function postChat(
  config: OpenAICompatibleConfig,
  body: Record<string, unknown>,
): Promise<{ response: ChatCompletionResponse; usage: ProviderUsage }> {
  const { attempts, baseDelayMs, maxDelayMs } = { ...DEFAULT_RETRY, ...config.retry };

  for (let attempt = 1; ; attempt++) {
    const started = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.timeoutMs ?? 30_000,
    );

    try {
      const fetchImpl = config.fetchImpl ?? fetch;
      const response = await fetchImpl(endpoint(config.baseUrl), {
        method: "POST",
        headers: headers(config.apiKey),
        body: JSON.stringify(
          config.maxTokens === undefined ? body : { max_tokens: config.maxTokens, ...body },
        ),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new ProviderHttpError(
          response.status,
          `Provider request failed: ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
        );
      }

      const json = (await response.json()) as ChatCompletionResponse;
      return {
        response: json,
        usage: {
          inputTokens: json.usage?.prompt_tokens,
          outputTokens: json.usage?.completion_tokens,
          totalTokens: json.usage?.total_tokens,
          costUsd: json.usage?.cost,
          latencyMs: performance.now() - started,
        },
      };
    } catch (error) {
      // Full jitter over a capped exponential window: enough spread that a fleet of
      // parallel decision calls does not retry in lockstep.
      const retryable = isTransient(error) && attempt < attempts;
      if (!retryable) throw error;
      await sleep(Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Deterministic PRNG (mulberry32) so baseline runs can be replayed by seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface RandomDecisionOptions {
  /**
   * `false` picks only among the supplied choices, even when the request
   * allows unknown. Baselines use this: a uniform pick of "none" only ends
   * the run, which measures nothing. Default: follow the request.
   */
  allowUnknown?: boolean;
}

export class RandomDecisionProvider implements DecisionProvider {
  constructor(
    private readonly random: () => number = Math.random,
    private readonly options: RandomDecisionOptions = {},
  ) {}

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const started = performance.now();
    const choices = ensureChoices(
      this.options.allowUnknown === false
        ? { ...request, allowUnknown: false }
        : request,
    );
    const index = Math.min(
      choices.length - 1,
      Math.floor(this.random() * choices.length),
    );
    const selected = choices[index]!.id;
    const probability = 1 / choices.length;
    const scores = Object.fromEntries(
      choices.map((choice) => [choice.id, probability]),
    );

    return {
      selected: [selected],
      scores,
      confidence: probability,
      entropy: Math.log(choices.length),
      identity: { provider: "random" },
      usage: { latencyMs: performance.now() - started },
    };
  }
}

export class OpenAICompatibleDecisionProvider implements DecisionProvider {
  constructor(private readonly config: OpenAICompatibleConfig) {}

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const choices = ensureChoices(request);
    const ids = choices.map((choice) => choice.id);

    const contract = {
      selected: "one choice id, or an ordered array of ids for rank mode",
      scores: Object.fromEntries(ids.map((id) => [id, "non-negative number"])),
      confidence: "optional number from 0 to 1",
    };

    const system = [
      "You are Lattice's bounded decision engine.",
      "Use only the supplied state, question and choices.",
      "Do not invent repository facts.",
      `Return JSON only matching this contract: ${JSON.stringify(contract)}.`,
      `Valid choice IDs: ${ids.join(", ")}.`,
      `If evidence is insufficient, select ${UNKNOWN_CHOICE_ID} when available.`,
    ].join("\n");

    const user = JSON.stringify({
      mode: request.mode ?? "choice",
      state: request.state ?? "",
      question: request.question,
      choices,
    });

    const body: Record<string, unknown> = {
      model: this.config.model,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };

    if (this.config.jsonMode !== false) {
      body.response_format = { type: "json_object" };
    }

    const { response, usage } = await postChat(this.config, body);
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error("Decision provider returned empty content");

    const parsed = extractJsonObject(content) as DecisionEnvelope;
    const rawSelected = Array.isArray(parsed.selected)
      ? parsed.selected
      : parsed.selected
        ? [parsed.selected]
        : [];

    if (rawSelected.length === 0) {
      throw new Error("Decision provider returned no selected choice");
    }

    for (const id of rawSelected) {
      if (!ids.includes(id)) {
        throw new Error(`Decision provider selected unknown choice ID: ${id}`);
      }
    }

    const scores = normalizeScores(ids, parsed.scores);
    const scoreMax = Math.max(...Object.values(scores));
    const parsedConfidence = finiteNonNegative(parsed.confidence);
    const confidence =
      scoreMax > 0 ? scoreMax : parsedConfidence !== undefined
        ? Math.min(parsedConfidence, 1)
        : undefined;

    return {
      selected: rawSelected,
      scores,
      confidence,
      entropy: entropy(scores),
      identity: {
        provider: this.config.providerName ?? "openai-compatible",
        model: this.config.model,
      },
      usage,
    };
  }
}

export interface SystemOneConfig {
  baseUrl: string;
  model: string;
  keepAlive?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  providerName?: string;
}

export class SystemOneDecisionProvider implements DecisionProvider {
  constructor(private readonly config: SystemOneConfig) {}

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const started = performance.now();
    const choices = ensureChoices(request);
    const ids = choices.map((c) => c.id);

    const criteria: Record<string, string> = {};
    for (const c of choices) {
      if (c.id === UNKNOWN_CHOICE_ID) {
        criteria[c.id] =
          "No supplied choice applies or evidence is insufficient to decide.";
      } else {
        criteria[c.id] = c.detail ?? c.label ?? c.id;
      }
    }

    const state =
      typeof request.state === "string"
        ? request.state
        : request.state !== undefined
          ? JSON.stringify(request.state)
          : "";

    const body = {
      model: this.config.model,
      state,
      questions: {
        next_action: {
          type: "choice",
          instructions: request.question,
          criteria,
        },
      },
      keep_alive: this.config.keepAlive ?? "30m",
    };

    const base = this.config.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    const url = `${base}/v1/systemone`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 30_000,
    );

    try {
      const fetchImpl = this.config.fetchImpl ?? fetch;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `SystemOne decision request failed: ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
        );
      }

      const json = (await response.json()) as {
        answers?: {
          next_action?: {
            choice?: string;
            probabilities?: Record<string, number>;
            confidence?: number;
          };
        };
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
        };
      };

      const ans = json.answers?.next_action;
      const selectedId = ans?.choice;
      if (!selectedId || !ids.includes(selectedId)) {
        throw new Error(
          `Decision provider selected unknown choice ID: ${selectedId ?? "none"}`,
        );
      }

      const rawScores = ans?.probabilities ?? {};
      const scores = normalizeScores(ids, rawScores);
      const scoreMax = Math.max(...Object.values(scores));
      const confidence =
        scoreMax > 0
          ? scoreMax
          : ans?.confidence !== undefined
            ? Math.min(ans.confidence, 1)
            : undefined;

      return {
        selected: [selectedId],
        scores,
        confidence,
        entropy: entropy(scores),
        identity: {
          provider: this.config.providerName ?? "systemone",
          model: this.config.model,
        },
        usage: {
          latencyMs: performance.now() - started,
          inputTokens: json.usage?.input_tokens,
          outputTokens: json.usage?.output_tokens,
          totalTokens:
            (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0),
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class OpenAICompatibleGeneratorProvider implements GeneratorProvider {
  constructor(private readonly config: OpenAICompatibleConfig) {}

  async generate(request: GeneratorRequest): Promise<GeneratorResult> {
    if (request.maxTokens !== undefined && (!Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1)) {
      throw new Error("maxTokens must be a positive integer");
    }
    const messages: Array<{ role: string; content: string }> = [];
    if (request.system) {
      messages.push({ role: "system", content: request.system });
    }

    const context = request.context?.length
      ? `\n\nContext:\n${request.context.join("\n---\n")}`
      : "";

    messages.push({
      role: "user",
      content: request.prompt + context,
    });

    const { response, usage } = await postChat(this.config, {
      model: this.config.model,
      temperature: request.temperature ?? 0.2,
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      messages,
    });

    if (response.choices?.[0]?.finish_reason === "length") {
      throw new Error("Generator output exceeded the token limit; narrow the task or increase maxTokens");
    }
    const message = response.choices?.[0]?.message;
    const text =
      message?.content ??
      (message as { reasoning?: string })?.reasoning ??
      (message as { reasoning_content?: string })?.reasoning_content;
    if (!text) throw new Error("Generator provider returned empty content");

    return {
      text,
      identity: {
        provider: this.config.providerName ?? "openai-compatible",
        model: this.config.model,
      },
      usage,
    };
  }
}

export * from "./claude-code.js";
