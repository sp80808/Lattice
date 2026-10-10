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
  jsonMode?: boolean;
  fetchImpl?: FetchLike;
  providerName?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
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
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
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
        latencyMs: performance.now() - started,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export class RandomDecisionProvider implements DecisionProvider {
  constructor(private readonly random: () => number = Math.random) {}

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const started = performance.now();
    const choices = ensureChoices(request);
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

    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/v1/systemone`;
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
      messages,
    });

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
