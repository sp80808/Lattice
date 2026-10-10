import type { FetchLike } from "./index.js";

/**
 * Provider-aware model execution registry.
 *
 * Lattice previously assumed every configured model was reachable through the
 * Ollama OpenAI-compatible `/v1/chat/completions` route. That assumption is
 * false: a model's *runner* and *declared capabilities* decide which API it
 * actually speaks. `tev1:0.8b` exposes only a `decision` capability and is
 * reachable through `/v1/systemone`; asking it for chat completions returns
 * HTTP 400 ("does not support decision" / invalid request). Conversely
 * `qwen3:1.7b` and `qwen2.5-coder:1.5b` expose completion capabilities and
 * reject `/v1/systemone` with HTTP 400.
 *
 * This module makes that mismatch impossible to express silently:
 *   - every target records the exact model ID observed on its endpoint,
 *   - every target records the transport it was *verified* to speak,
 *   - dispatch is refused before execution when the pairing is unsupported,
 *   - no target is ever invented, substituted or downloaded implicitly.
 */

export type ModelRole =
  | "decision"
  | "generator"
  | "coding-worker"
  | "verifier"
  | "benchmark-executor";

export type TransportKind =
  | "ollama-native"
  | "ollama-openai-compatible"
  | "systemone-choice"
  | "openai-compatible"
  | "colab-remote-batch"
  | "cli-worker";

export type AvailabilityState =
  | "available"
  | "unreachable"
  | "disabled"
  | "exhausted"
  | "unknown";

export type AuthReadiness =
  | "not-required"
  | "ready"
  | "missing-credential"
  | "expired"
  | "unknown";

export interface ResourceRequirements {
  minMemoryMb?: number;
  accelerator?: "cpu" | "gpu" | "tpu" | "any";
  /** Colab compute units per hour, when the target bills in CU. */
  computeUnitsPerHour?: number;
  maxContextTokens?: number;
  maxOutputTokens?: number;
}

export interface PerformanceRecord {
  at: string;
  latencyMs: number;
  ok: boolean;
  /** Verified outcome, not a provider-reported status code. */
  verifiedOutcome?: boolean;
  detail?: string;
}

export interface PerformanceHistory {
  samples: number;
  meanLatencyMs?: number;
  p95LatencyMs?: number;
  successRate?: number;
  verifiedSuccessRate?: number;
  last?: PerformanceRecord;
}

export interface ExecutionTarget {
  /** Stable registry identifier. Never derived from a model name guess. */
  id: string;
  provider: string;
  /** Exact model identifier as observed on the endpoint. Never synthesised. */
  modelId: string;
  transport: TransportKind;
  endpoint: string;
  role: ModelRole;
  capabilities: string[];
  availability: AvailabilityState;
  auth: AuthReadiness;
  resources: ResourceRequirements;
  history: PerformanceHistory;
  /** True once the target answered a real request on this transport. */
  verified: boolean;
  /** Free-form provenance: config path, discovery source, adapter note. */
  provenance?: string;
}

/** Raised when a requested model is not present on any reachable endpoint. */
export class ModelNotAvailableError extends Error {
  constructor(
    readonly modelId: string,
    readonly searched: readonly string[],
  ) {
    super(
      `model ${JSON.stringify(modelId)} is not available on any configured endpoint ` +
        `(searched: ${searched.length ? searched.join(", ") : "none"}). ` +
        `Add it to the endpoint's model list or install it; Lattice never invents or downloads model IDs.`,
    );
    this.name = "ModelNotAvailableError";
  }
}

/** Raised when a model exists but cannot serve the requested role. */
export class IncompatibleTransportError extends Error {
  constructor(
    readonly target: ExecutionTarget,
    readonly role: ModelRole,
  ) {
    super(
      `model ${JSON.stringify(target.modelId)} on ${target.provider} does not support role "${role}": ` +
        `declared capabilities [${target.capabilities.join(", ") || "none"}] over transport ` +
        `"${target.transport}". Configure a target that actually supports this role.`,
    );
    this.name = "IncompatibleTransportError";
  }
}

/** Raised when no eligible target exists for a role. Fails closed. */
export class NoEligibleTargetError extends Error {
  constructor(
    readonly role: ModelRole,
    readonly rejected: readonly TargetRejection[],
  ) {
    const detail = rejected.length
      ? rejected.map((r) => `${r.targetId}: ${r.reason}`).join("; ")
      : "no targets registered";
    super(`no eligible execution target for role "${role}" (${detail})`);
    this.name = "NoEligibleTargetError";
  }
}

export interface TargetRejection {
  targetId: string;
  modelId: string;
  reason: string;
}

/** One audited dispatch decision. Zero silent substitutions. */
export interface DispatchRecord {
  role: ModelRole;
  targetId: string;
  provider: string;
  modelId: string;
  transport: TransportKind;
  endpoint: string;
  at: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Capability model
// ---------------------------------------------------------------------------

const DECISION_CAPABILITIES = ["decision", "choice", "rerank"];
const GENERATOR_CAPABILITIES = ["completion", "tools", "insert", "thinking", "code", "chat"];
const WORKER_CAPABILITIES = ["completion", "tools", "insert", "code", "agent"];

/** Which capability vocabulary a transport natively speaks. */
const TRANSPORT_CAPABILITIES: Record<TransportKind, string[]> = {
  "ollama-native": ["completion", "tools", "insert", "thinking", "embedding"],
  "ollama-openai-compatible": ["completion", "tools", "insert", "thinking", "chat"],
  "systemone-choice": ["decision", "choice"],
  "openai-compatible": ["completion", "tools", "insert", "thinking", "chat", "code"],
  "colab-remote-batch": ["completion", "decision", "benchmark", "training", "compiler", "test"],
  "cli-worker": ["completion", "tools", "code", "agent"],
};

export function transportCapabilities(transport: TransportKind): string[] {
  return TRANSPORT_CAPABILITIES[transport];
}

/**
 * Whether a transport can carry a role at all. A chat transport cannot carry a
 * typed-choice decision, and a choice transport cannot generate code.
 */
export function transportSupportsRole(role: ModelRole, transport: TransportKind): boolean {
  const caps = TRANSPORT_CAPABILITIES[transport];
  if (role === "decision") return DECISION_CAPABILITIES.some((c) => caps.includes(c));
  if (role === "generator") return GENERATOR_CAPABILITIES.some((c) => caps.includes(c));
  if (role === "coding-worker") return WORKER_CAPABILITIES.some((c) => caps.includes(c));
  if (role === "verifier") return caps.includes("test") || caps.includes("compiler");
  if (role === "benchmark-executor") return caps.includes("benchmark") || caps.includes("test");
  return false;
}

export function targetSupportsRole(target: ExecutionTarget, role: ModelRole): boolean {
  if (!transportSupportsRole(role, target.transport)) return false;
  const declared = new Set(target.capabilities);
  if (declared.size === 0) return true;
  const wanted =
    role === "decision"
      ? DECISION_CAPABILITIES
      : role === "generator"
        ? GENERATOR_CAPABILITIES
        : role === "coding-worker"
          ? WORKER_CAPABILITIES
          : role === "verifier"
            ? ["test", "compiler", "completion"]
            : ["benchmark", "test", "compiler", "completion"];
  return wanted.some((c) => declared.has(c));
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface OllamaModelReport {
  name: string;
  model: string;
  capabilities: string[];
  sizeBytes?: number;
  parameterSize?: string;
  quantization?: string;
  contextLength?: number;
  modifiedAt?: string;
  format?: string;
  family?: string;
  runner?: string;
}

interface OllamaTagEntry {
  name?: string;
  model?: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
  capabilities?: string[];
}

/**
 * Discover the models that *actually exist* on an Ollama endpoint, with the
 * capabilities Ollama itself reports. Never returns a model the endpoint did
 * not list.
 */
export async function discoverOllamaModels(
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 5_000,
): Promise<OllamaModelReport[]> {
  const base = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${base}/api/tags`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const json = (await response.json()) as { models?: OllamaTagEntry[] };
    return (json.models ?? []).map((entry) => {
      const name = entry.name ?? entry.model ?? "";
      return {
        name,
        model: entry.model ?? name,
        capabilities: dedupe([...(entry.capabilities ?? []), ...inferCapabilities(name, entry.details?.family)]),
        sizeBytes: entry.size,
        parameterSize: entry.details?.parameter_size,
        quantization: entry.details?.quantization_level,
        contextLength: undefined,
        modifiedAt: entry.modified_at,
        format: entry.details?.format,
        family: entry.details?.family,
        runner: undefined,
      };
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function inferCapabilities(name: string, family?: string): string[] {
  const haystack = `${name} ${family ?? ""}`.toLowerCase();
  const caps: string[] = [];
  if (/(coder|code|starcoder|codestral)/.test(haystack)) caps.push("code", "insert");
  if (/(instruct|chat|it$)/.test(haystack)) caps.push("chat");
  if (/(thinking|reasoner|r1)/.test(haystack)) caps.push("thinking");
  return caps;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function percentile(values: readonly number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface TargetSpec {
  id?: string;
  provider: string;
  modelId: string;
  transport: TransportKind;
  endpoint: string;
  role: ModelRole;
  capabilities?: string[];
  availability?: AvailabilityState;
  auth?: AuthReadiness;
  resources?: ResourceRequirements;
  provenance?: string;
}

export class ModelRegistry {
  private readonly targets = new Map<string, ExecutionTarget>();
  private readonly audit: DispatchRecord[] = [];

  register(spec: TargetSpec): ExecutionTarget {
    const id = spec.id ?? `${spec.provider}:${spec.modelId}@${spec.role}`;
    if (this.targets.has(id)) {
      throw new Error(`duplicate execution target id ${JSON.stringify(id)}`);
    }
    const target: ExecutionTarget = {
      id,
      provider: spec.provider,
      modelId: spec.modelId,
      transport: spec.transport,
      endpoint: spec.endpoint,
      role: spec.role,
      capabilities: dedupe(spec.capabilities ?? []),
      availability: spec.availability ?? "unknown",
      auth: spec.auth ?? "unknown",
      resources: spec.resources ?? {},
      history: { samples: 0 },
      verified: false,
      provenance: spec.provenance,
    };
    this.targets.set(id, target);
    return target;
  }

  /** Register every discovered Ollama model under an explicit role/transport. */
  registerDiscoveredOllama(
    baseUrl: string,
    role: ModelRole,
    reports: readonly OllamaModelReport[],
    options: { idPrefix?: string; provider?: string } = {},
  ): ExecutionTarget[] {
    const provider = options.provider ?? "ollama";
    return reports.map((report) => {
      const transport: TransportKind = role === "decision" && report.capabilities.includes("decision")
        ? "systemone-choice"
        : "ollama-openai-compatible";
      return this.register({
        id: `${options.idPrefix ?? provider}:${report.name}@${role}`,
        provider,
        modelId: report.name,
        transport,
        endpoint: baseUrl,
        role,
        capabilities: report.capabilities,
        availability: "available",
        auth: "not-required",
        resources: {
          maxContextTokens: report.contextLength,
          accelerator: "cpu",
        },
        provenance: `discovered from ${baseUrl.replace(/\/+$/, "")}/api/tags`,
      });
    });
  }

  get(id: string): ExecutionTarget | undefined {
    return this.targets.get(id);
  }

  list(): ExecutionTarget[] {
    return [...this.targets.values()];
  }

  /** Locate a target by exact model ID. Never fuzzy-matches or substitutes. */
  findByModelId(modelId: string, role?: ModelRole): ExecutionTarget[] {
    return this.list().filter((t) => t.modelId === modelId && (role === undefined || t.role === role));
  }

  markReachable(id: string, reachable: boolean, detail?: string): void {
    const target = this.targets.get(id);
    if (!target) return;
    target.availability = reachable ? "available" : "unreachable";
    if (detail) {
      target.history = {
        ...target.history,
        last: { at: new Date().toISOString(), latencyMs: 0, ok: reachable, detail },
      };
    }
  }

  recordPerformance(id: string, record: PerformanceRecord): void {
    const target = this.targets.get(id);
    if (!target) return;
    const history = target.history;
    const samples = history.samples + 1;
    const previousTotal = (history.meanLatencyMs ?? 0) * history.samples;
    const meanLatencyMs = (previousTotal + record.latencyMs) / samples;
    const successes = (history.successRate ?? 0) * history.samples + (record.ok ? 1 : 0);
    const verified =
      (history.verifiedSuccessRate ?? 0) * history.samples + (record.verifiedOutcome === true ? 1 : 0);
    target.history = {
      samples,
      meanLatencyMs,
      p95LatencyMs: percentile(
        [history.meanLatencyMs ?? record.latencyMs, record.latencyMs],
        95,
      ),
      successRate: successes / samples,
      verifiedSuccessRate: verified / samples,
      last: record,
    };
    target.verified = target.verified || record.ok;
  }

  /**
   * Select the best eligible target for a role.
   *
   * Fail-closed: returns rejections instead of substituting a different model.
   */
  select(role: ModelRole, task?: { requires?: string[]; minVerifiedSamples?: number }): ExecutionTarget {
    const rejected: TargetRejection[] = [];
    const eligible: ExecutionTarget[] = [];

    for (const target of this.targets.values()) {
      if (target.role !== role) continue;
      if (!targetSupportsRole(target, role)) {
        rejected.push({ targetId: target.id, modelId: target.modelId, reason: `transport ${target.transport} cannot carry role ${role}` });
        continue;
      }
      if (target.availability !== "available") {
        rejected.push({ targetId: target.id, modelId: target.modelId, reason: `availability is ${target.availability}` });
        continue;
      }
      if (target.auth !== "ready" && target.auth !== "not-required") {
        rejected.push({ targetId: target.id, modelId: target.modelId, reason: `auth is ${target.auth}` });
        continue;
      }
      for (const requirement of task?.requires ?? []) {
        if (!target.capabilities.includes(requirement)) {
          rejected.push({ targetId: target.id, modelId: target.modelId, reason: `missing required capability ${requirement}` });
        }
      }
      if (rejected.some((r) => r.targetId === target.id)) continue;
      eligible.push(target);
    }

    if (!eligible.length) throw new NoEligibleTargetError(role, rejected);

    const scored = eligible.map((target) => ({ target, score: scoreTarget(target, task) }));
    scored.sort((a, b) => b.score - a.score || a.target.id.localeCompare(b.target.id));
    const chosen = scored[0];
    this.audit.push({
      role,
      targetId: chosen.target.id,
      provider: chosen.target.provider,
      modelId: chosen.target.modelId,
      transport: chosen.target.transport,
      endpoint: chosen.target.endpoint,
      at: new Date().toISOString(),
      reason:
        scored.length === 1
          ? "sole eligible target"
          : `highest score ${chosen.score.toFixed(3)} among ${scored.length} eligible`,
    });
    return chosen.target;
  }

  /** Dispatch history. Proves no silent substitution happened. */
  auditTrail(): readonly DispatchRecord[] {
    return this.audit;
  }
}

function scoreTarget(target: ExecutionTarget, task?: { minVerifiedSamples?: number }): number {
  const minSamples = task?.minVerifiedSamples ?? 20;
  let score = 0;
  const history = target.history;
  if (history.verifiedSuccessRate !== undefined && history.samples >= minSamples) {
    score += history.verifiedSuccessRate * 100;
  }
  if (history.successRate !== undefined) score += history.successRate * 10;
  if (history.meanLatencyMs !== undefined) score += Math.max(0, 20 - history.meanLatencyMs / 100);
  if (target.verified) score += 5;
  if (target.resources.computeUnitsPerHour) score -= target.resources.computeUnitsPerHour * 2;
  if (target.resources.accelerator === "cpu") score += 2;
  return score;
}

/**
 * Build a registry from a live Ollama endpoint, registering each discovered
 * model under every requested role it can actually serve.
 *
 * Discovery is authoritative: a model the endpoint does not list cannot be
 * selected, and a model whose declared capabilities cannot carry a role is
 * still registered (so the failure is explainable) but will be rejected by
 * {@link ModelRegistry.select}.
 */
export async function registerTargetsFromLiveOllama(
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
  options: { roles?: ModelRole[]; provider?: string; timeoutMs?: number } = {},
): Promise<ModelRegistry> {
  const roles = options.roles ?? ["decision", "generator"];
  const reports = await discoverOllamaModels(baseUrl, fetchImpl, options.timeoutMs);
  const registry = new ModelRegistry();
  for (const role of roles) {
    registry.registerDiscoveredOllama(baseUrl, role, reports, {
      provider: options.provider ?? "ollama",
      idPrefix: options.provider ?? "ollama",
    });
  }
  return registry;
}

/**
 * Resolve a configured model ID against a registry without inventing anything.
 *
 * Returns the registered target when the exact model ID and role are present,
 * otherwise raises with the search space recorded so the failure is actionable.
 */
export function resolveTarget(
  registry: ModelRegistry,
  modelId: string,
  role: ModelRole,
): ExecutionTarget {
  const matches = registry.findByModelId(modelId, role);
  if (matches.length) return matches[0];
  const anyRole = registry.findByModelId(modelId);
  if (anyRole.length) {
    throw new IncompatibleTransportError(anyRole[0], role);
  }
  throw new ModelNotAvailableError(modelId, registry.list().map((t) => t.endpoint));
}

/** Auth readiness for a target that names an environment variable. */
export function authReadiness(apiKeyEnv: string | undefined, env: Record<string, string | undefined>): AuthReadiness {
  if (!apiKeyEnv) return "not-required";
  const value = env[apiKeyEnv];
  if (value === undefined || value === "") return "missing-credential";
  return "ready";
}
