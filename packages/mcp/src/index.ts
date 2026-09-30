/**
 * Minimal MCP server (JSON-RPC 2.0 over newline-delimited stdio) that exposes
 * Lattice to MCP clients such as Claude Code, Codex and Cursor.
 *
 * Hand-rolled on purpose: the tool surface is small and the stdio framing is
 * trivial, so an SDK dependency would add more than it removes.
 */
import { createInterface } from "node:readline";
import { isAbsolute, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  decide,
  executeTask,
  getRun,
  getStats,
  LATTICE_VERSION,
  LatticeServiceError,
  listRuns,
  parseDecisionRequest,
  runDoctor,
} from "@lattice/service";

export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
  run(args: Record<string, unknown>, cwd: string): Promise<unknown>;
}

export interface McpServerOptions {
  /** Default project directory for tools that are not given `cwd`. */
  cwd?: string;
}

const cwdProperty = {
  type: "string",
  description: "Project directory (absolute, or relative to the server's cwd). Defaults to the server's cwd.",
};

function stringArg(args: Record<string, unknown>, name: string, required = false): string | undefined {
  const value = args[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value.trim())) {
    throw new LatticeServiceError("invalid_request", `${name} must be a${required ? " non-empty" : ""} string`);
  }
  return value;
}

function tools(): ToolDefinition[] {
  return [
    {
      name: "lattice_run",
      title: "Run a Lattice task",
      description:
        "Ground a coding task in repository and verifier evidence and record a replayable run. " +
        "mode=observe (default) only gathers evidence and runs the configured verifier. " +
        "mode=configured honours .lattice/config.json; with mode:auto that runs model search and " +
        "coding agents in isolated git worktrees, which can take minutes.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "The coding task in plain language." },
          mode: { type: "string", enum: ["observe", "configured"], default: "observe" },
          cwd: cwdProperty,
        },
        required: ["task"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      async run(args, cwd) {
        const mode = stringArg(args, "mode") ?? "observe";
        if (mode !== "observe" && mode !== "configured") {
          throw new LatticeServiceError("invalid_request", "mode must be 'observe' or 'configured'");
        }
        const outcome = await executeTask(stringArg(args, "task", true)!, { cwd, mode });
        const { result } = outcome;
        return {
          runId: result.runId,
          status: result.status,
          summary: result.summary,
          mode: outcome.mode,
          runtimeMode: outcome.runtimeMode,
          evidence: result.tap.evidence.map(({ id, kind, verified, summary }) => ({ id, kind, verified, summary })),
          uncertainties: result.tap.uncertainties,
          eventLogPath: result.eventLogPath,
        };
      },
    },
    {
      name: "lattice_runs",
      title: "List Lattice runs",
      description: "List recorded Lattice runs for a project, newest first.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 200, default: 20 },
          cwd: cwdProperty,
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args, cwd) {
        const limit = args.limit === undefined ? undefined : Number(args.limit);
        return { runs: await listRuns({ cwd, limit }) };
      },
    },
    {
      name: "lattice_show_run",
      title: "Show a Lattice run",
      description: "Show one run's status, summary and TAP packet (objectives, evidence, uncertainties).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Run ID, unambiguous prefix, or 'latest'." },
          cwd: cwdProperty,
        },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: (args, cwd) => getRun(stringArg(args, "id", true)!, cwd),
    },
    {
      name: "lattice_decide",
      title: "Bounded decision",
      description:
        "Ask Lattice's cheap decision model to pick among finite choices. An explicit " +
        "'__none__' (unknown) option is added unless allowUnknown=false. provider=random is an offline baseline.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string" },
          choices: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                detail: { type: "string" },
              },
              required: ["id", "label"],
            },
          },
          state: { type: "string", description: "Compact evidence/state for the decision." },
          mode: { type: "string", enum: ["choice", "rank", "boolean", "score"] },
          allowUnknown: { type: "boolean" },
          provider: { type: "string", enum: ["configured", "random"], default: "configured" },
          cwd: cwdProperty,
        },
        required: ["question", "choices"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      run(args, cwd) {
        const provider = stringArg(args, "provider") ?? "configured";
        if (provider !== "configured" && provider !== "random") {
          throw new LatticeServiceError("invalid_request", "provider must be 'configured' or 'random'");
        }
        return decide(parseDecisionRequest(args), { cwd, provider });
      },
    },
    {
      name: "lattice_stats",
      title: "Decision calibration stats",
      description: "Aggregate decision confidence vs objective outcomes across recorded runs.",
      inputSchema: { type: "object", properties: { cwd: cwdProperty }, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: (_args, cwd) => getStats(cwd),
    },
    {
      name: "lattice_doctor",
      title: "Check Lattice setup",
      description: "Check Node, git, config, model endpoint reachability, coding-agent and verifier binaries.",
      inputSchema: {
        type: "object",
        properties: {
          network: { type: "boolean", default: true, description: "Probe model endpoints." },
          cwd: cwdProperty,
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: (args, cwd) => runDoctor({ cwd, network: args.network !== false }),
    },
  ];
}

/** Transport-agnostic JSON-RPC handler. Returns undefined for notifications. */
export function createMcpHandler(options: McpServerOptions = {}) {
  const baseCwd = resolve(options.cwd ?? process.cwd());
  const registry = new Map(tools().map((tool) => [tool.name, tool]));

  const ok = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const fail = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  async function callTool(params: Record<string, unknown>) {
    const tool = typeof params.name === "string" ? registry.get(params.name) : undefined;
    if (!tool) return undefined;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const requested = stringArg(args, "cwd");
      const cwd = requested ? (isAbsolute(requested) ? requested : resolve(baseCwd, requested)) : baseCwd;
      const result = await tool.run(args, cwd);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      // Tool failures are results the model can read, not protocol errors.
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof LatticeServiceError ? `${error.code}: ` : "";
      return { content: [{ type: "text", text: code + message }], isError: true };
    }
  }

  return async function handle(message: unknown): Promise<JsonRpcResponse | undefined> {
    const request = message as Partial<JsonRpcRequest>;
    if (!request || typeof request !== "object" || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return fail(request?.id ?? null, -32600, "invalid JSON-RPC request");
    }
    const isNotification = request.id === undefined;
    const id = request.id ?? null;
    const params = request.params ?? {};

    switch (request.method) {
      case "initialize": {
        const requested = params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested as never)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0];
        return ok(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "lattice", title: "Lattice", version: LATTICE_VERSION },
          instructions:
            "Lattice grounds coding tasks in objective evidence. Prefer lattice_run with mode=observe to " +
            "capture repository + test evidence; only use mode=configured when the user wants Lattice's own " +
            "search and coding agents to attempt the task.",
        });
      }
      case "ping":
        return isNotification ? undefined : ok(id, {});
      case "tools/list":
        return ok(id, {
          tools: [...registry.values()].map(({ run: _run, ...definition }) => definition),
        });
      case "tools/call": {
        const result = await callTool(params);
        return result ? ok(id, result) : fail(id, -32602, `unknown tool: ${String(params.name)}`);
      }
      default:
        if (isNotification) return undefined; // notifications/initialized, cancelled, etc.
        return fail(id, -32601, `method not found: ${request.method}`);
    }
  };
}

/** Serve MCP over newline-delimited stdio until input closes. Logs go to stderr only. */
export async function serveMcpStdio(
  options: McpServerOptions & { input?: Readable; output?: Writable } = {},
): Promise<void> {
  const handle = createMcpHandler(options);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const pending = new Set<Promise<void>>();
  const write = (response: JsonRpcResponse | undefined) => {
    if (response) output.write(JSON.stringify(response) + "\n");
  };

  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    // Handle concurrently so a long lattice_run does not block ping/tools/list.
    const task = handle(message)
      .then(write)
      .catch((error) => {
        process.stderr.write(`lattice mcp: ${error instanceof Error ? error.stack : String(error)}\n`);
        const id = (message as { id?: JsonRpcId }).id;
        if (id !== undefined) write({ jsonrpc: "2.0", id, error: { code: -32603, message: "internal error" } });
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  }
  await Promise.all(pending);
}
