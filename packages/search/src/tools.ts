/**
 * Progressive MCP tool discovery over a capability-scoped registry (#66).
 *
 * Servers' `tools/list` results are ingested once. A model never sees every
 * schema: it searches compact one-line summaries, inspects the exact schema of
 * the one it wants, and the caller authorizes the invocation against the
 * schema version that was inspected. Every step is filtered by a grant the
 * operator configured. Tool descriptions are untrusted text from the server:
 * they feed ranking and nothing else, so no description can widen a grant.
 *
 * This is a registry and retrieval layer only; calling a tool still goes
 * through the existing MCP transport.
 */
import { createHash } from "node:crypto";
import { Bm25SkillRetriever } from "./retrieval.js";
import type { TrustLevel } from "./capabilities.js";

/** A tool as returned by an MCP server's `tools/list`. */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface RegisteredTool {
  /** `<server>/<tool>`: tool names only have to be unique per server. */
  id: string;
  server: string;
  name: string;
  /** Sanitized, clipped description. Untrusted server text. */
  summary: string;
  inputSchema: Record<string, unknown>;
  /** Hash of the name, description and schema; changes when any of them do. */
  schemaVersion: string;
  /** Operator-assigned capability tags; never derived from the description. */
  tags: string[];
  trust: TrustLevel;
  available: boolean;
}

export interface ToolServerOptions {
  trust: TrustLevel;
  /** Capability tags per tool name; `*` applies to every tool of the server. */
  tags?: Record<string, string[]>;
}

export interface IngestReport {
  server: string;
  accepted: string[];
  rejected: Array<{ name: string; reason: string }>;
}

/**
 * What one agent may discover and invoke. A tool is in scope when it is
 * available, within `maxTrust`, and either listed in `tools` (an id or
 * `<server>/*`) or carrying one of `tags`. An empty grant grants nothing.
 */
export interface ToolGrant {
  tools?: string[];
  tags?: string[];
  maxTrust?: TrustLevel;
}

export interface ToolCandidate {
  id: string;
  summary: string;
  schemaVersion: string;
  score: number;
}

/** JSON-serializable record of one discovery, for the run log and replay. */
export interface ToolDiscoveryRecord {
  query: string;
  registryVersion: string;
  /** In-scope tools the search ranked over. */
  considered: number;
  candidates: ToolCandidate[];
  /** Characters the candidates add to a prompt. */
  promptChars: number;
  /** Characters every in-scope schema would have added instead. */
  eagerChars: number;
}

export class ToolAccessError extends Error {
  constructor(
    readonly toolId: string,
    readonly reason: "unknown" | "out_of_scope" | "unavailable" | "stale_schema",
  ) {
    super(
      reason === "unknown"
        ? `no tool ${toolId}`
        : reason === "out_of_scope"
          ? `tool ${toolId} is outside this agent's grant`
          : reason === "unavailable"
            ? `tool ${toolId} is unavailable (its server disconnected)`
            : `tool ${toolId} changed since its schema was inspected`,
    );
    this.name = "ToolAccessError";
  }
}

const TRUST_ORDER: TrustLevel[] = ["verified", "local", "third_party", "untrusted"];
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const SERVER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_SUMMARY = 200;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** One line of plain text: no control characters, bounded length. */
function sanitizeSummary(text: string | undefined): string {
  const flat = (text ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > MAX_SUMMARY ? `${flat.slice(0, MAX_SUMMARY - 1)}\u2026` : flat;
}

function validate(tool: unknown): string | undefined {
  if (!tool || typeof tool !== "object") return "not an object";
  const { name, description, inputSchema } = tool as Record<string, unknown>;
  if (typeof name !== "string" || !TOOL_NAME.test(name)) return "invalid name";
  if (description !== undefined && typeof description !== "string") return "description is not a string";
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    return "inputSchema is not an object";
  }
  const schema = inputSchema as Record<string, unknown>;
  if (schema.type !== "object") return 'inputSchema.type is not "object"';
  if (
    schema.properties !== undefined &&
    (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties))
  ) {
    return "inputSchema.properties is not an object";
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== "string"))) {
    return "inputSchema.required is not a string array";
  }
  return undefined;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly indexes = new Map<string, { tools: RegisteredTool[]; retriever: Bm25SkillRetriever }>();

  /**
   * Replace everything known about `server` with its current `tools/list`.
   * Malformed and duplicate tools are rejected individually; the rest load.
   */
  ingest(server: string, tools: unknown[], options: ToolServerOptions): IngestReport {
    if (!SERVER_NAME.test(server)) throw new Error(`invalid server name: ${JSON.stringify(server)}`);
    if (!TRUST_ORDER.includes(options.trust)) throw new Error(`invalid trust level: ${String(options.trust)}`);
    const report: IngestReport = { server, accepted: [], rejected: [] };
    const next = new Map<string, RegisteredTool>();
    for (const raw of Array.isArray(tools) ? tools : []) {
      const problem = validate(raw);
      const name = (raw as { name?: unknown } | null)?.name;
      const label = typeof name === "string" ? name : "<unnamed>";
      if (problem) {
        report.rejected.push({ name: label, reason: problem });
        continue;
      }
      const tool = raw as McpToolDefinition;
      if (next.has(tool.name)) {
        // Which copy would run is ambiguous, so neither is trusted with the name.
        report.rejected.push({ name: tool.name, reason: "duplicate name" });
        next.delete(tool.name);
        continue;
      }
      if (report.rejected.some((entry) => entry.name === tool.name && entry.reason === "duplicate name")) {
        report.rejected.push({ name: tool.name, reason: "duplicate name" });
        continue;
      }
      const tags = [...new Set([...(options.tags?.["*"] ?? []), ...(options.tags?.[tool.name] ?? [])])].sort();
      next.set(tool.name, {
        id: `${server}/${tool.name}`,
        server,
        name: tool.name,
        summary: sanitizeSummary(tool.description),
        inputSchema: structuredClone(tool.inputSchema),
        schemaVersion: hash(canonical({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema })),
        tags,
        trust: options.trust,
        available: true,
      });
    }
    for (const [id, tool] of this.tools) if (tool.server === server) this.tools.delete(id);
    for (const tool of next.values()) {
      this.tools.set(tool.id, tool);
      report.accepted.push(tool.id);
    }
    report.accepted.sort();
    this.indexes.clear();
    return report;
  }

  /** A disconnected server's tools stay known but can't be found or invoked. */
  disconnect(server: string): void {
    for (const tool of this.tools.values()) if (tool.server === server) tool.available = false;
    this.indexes.clear();
  }

  /** Changes whenever any tool, schema or availability changes. */
  get version(): string {
    return hash(
      canonical(
        [...this.tools.values()]
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map((tool) => [tool.id, tool.schemaVersion, tool.trust, tool.tags, tool.available]),
      ),
    );
  }

  get size(): number {
    return this.tools.size;
  }

  private inScope(tool: RegisteredTool, grant: ToolGrant): boolean {
    if (!tool.available) return false;
    const maxTrust = TRUST_ORDER.indexOf(grant.maxTrust ?? "local");
    if (TRUST_ORDER.indexOf(tool.trust) > maxTrust) return false;
    const listed = (grant.tools ?? []).some((entry) => entry === tool.id || entry === `${tool.server}/*`);
    const tagged = (grant.tags ?? []).some((tag) => tool.tags.includes(tag));
    return listed || tagged;
  }

  private scoped(grant: ToolGrant): { tools: RegisteredTool[]; retriever: Bm25SkillRetriever } {
    const key = canonical({
      tools: [...(grant.tools ?? [])].sort(),
      tags: [...(grant.tags ?? [])].sort(),
      maxTrust: grant.maxTrust ?? "local",
    });
    let index = this.indexes.get(key);
    if (!index) {
      // Rank only over what this agent may use, so out-of-scope descriptions
      // cannot even shift the scores of in-scope tools.
      const tools = [...this.tools.values()]
        .filter((tool) => this.inScope(tool, grant))
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      const retriever = new Bm25SkillRetriever(
        tools.map((tool) => ({ id: tool.id, name: tool.name, description: tool.summary, keywords: tool.tags })),
      );
      index = { tools, retriever };
      this.indexes.set(key, index);
    }
    return index;
  }

  /** Step 1: compact, deterministic shortlist. No schemas. */
  search(query: string, grant: ToolGrant, options: { topK?: number } = {}): ToolDiscoveryRecord {
    const { tools, retriever } = this.scoped(grant);
    const byId = new Map(tools.map((tool) => [tool.id, tool]));
    const candidates = retriever
      .retrieve(query)
      // Scores are rounded so ordering cannot hinge on float noise; ties go by id.
      .map((match) => ({ tool: byId.get(match.skill.id)!, score: Math.round(match.score * 1e6) / 1e6 }))
      .sort((a, b) => b.score - a.score || (a.tool.id < b.tool.id ? -1 : 1))
      .slice(0, options.topK ?? 8)
      .map(({ tool, score }) => ({ id: tool.id, summary: tool.summary, schemaVersion: tool.schemaVersion, score }));
    return {
      query,
      registryVersion: this.version,
      considered: tools.length,
      candidates,
      promptChars: renderToolCandidates(candidates).length,
      eagerChars: tools.reduce(
        (sum, tool) => sum + JSON.stringify({ name: tool.id, description: tool.summary, inputSchema: tool.inputSchema }).length,
        0,
      ),
    };
  }

  /** Step 2: the exact schema of one in-scope tool. */
  inspect(id: string, grant: ToolGrant): RegisteredTool {
    const tool = this.require(id, grant);
    return structuredClone(tool);
  }

  /** Step 3: refuse an invocation that is out of scope or against a changed schema. */
  authorize(id: string, schemaVersion: string, grant: ToolGrant): RegisteredTool {
    const tool = this.require(id, grant);
    if (tool.schemaVersion !== schemaVersion) throw new ToolAccessError(id, "stale_schema");
    return tool;
  }

  private require(id: string, grant: ToolGrant): RegisteredTool {
    const tool = this.tools.get(id);
    if (!tool) throw new ToolAccessError(id, "unknown");
    if (!tool.available) throw new ToolAccessError(id, "unavailable");
    if (!this.inScope(tool, grant)) throw new ToolAccessError(id, "out_of_scope");
    return tool;
  }
}

/**
 * Candidates as prompt text. Summaries are server-provided, so they are
 * quoted as data rather than spliced in as instructions.
 */
export function renderToolCandidates(candidates: ToolCandidate[]): string {
  return candidates.map((candidate) => `- ${candidate.id}: ${JSON.stringify(candidate.summary)}`).join("\n");
}

/**
 * Re-run a recorded discovery and report the first difference, so a replay
 * never silently picks different tools. Undefined means it matches.
 */
export function compareToolDiscovery(
  recorded: ToolDiscoveryRecord,
  registry: ToolRegistry,
  grant: ToolGrant,
  options: { topK?: number } = {},
): string | undefined {
  const current = registry.search(recorded.query, grant, { topK: options.topK ?? Math.max(recorded.candidates.length, 1) });
  if (current.registryVersion !== recorded.registryVersion) {
    const changed = recorded.candidates.find(
      (candidate) => !current.candidates.some((now) => now.id === candidate.id && now.schemaVersion === candidate.schemaVersion),
    );
    if (changed) return `tool ${changed.id} changed or is no longer offered (registry ${recorded.registryVersion} -> ${current.registryVersion})`;
  }
  const recordedIds = recorded.candidates.map((candidate) => candidate.id);
  const currentIds = current.candidates.slice(0, recordedIds.length).map((candidate) => candidate.id);
  const at = recordedIds.findIndex((id, index) => currentIds[index] !== id);
  if (at >= 0) return `candidate ${at + 1} was ${recordedIds[at]}, now ${currentIds[at] ?? "none"}`;
  return undefined;
}
