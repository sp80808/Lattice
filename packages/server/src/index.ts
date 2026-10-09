import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute, resolve } from "node:path";
import type { ApiErrorBody, TaskAccepted, TaskExecutionMode, TaskIntent } from "@lattice/protocol";
import {
  decide,
  executeTask,
  followRunEvents,
  getRun,
  getRunEvents,
  getStats,
  LATTICE_VERSION,
  LatticeServiceError,
  listRuns,
  parseDecisionRequest,
  resolveRunId,
  ReviewBroker,
  runDoctor,
  startTask,
} from "@lattice/service";

export interface LatticeServerOptions {
  /** Project directory used when a request does not pass `cwd`. */
  cwd?: string;
  /** Require `Authorization: Bearer <token>` on every request except /health. */
  token?: string;
  /** Browser origins allowed to call the API. Requests with any other Origin are refused. */
  allowedOrigins?: string[];
  /** Execution mode for POST /v1/tasks when the body omits `mode`. Default `observe`. */
  defaultMode?: TaskExecutionMode;
  maxBodyBytes?: number;
  /** How long a `review: "remote"` decision waits for an answer before stopping. Default 10 min. */
  reviewTimeoutMs?: number;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const STATUS_BY_CODE: Record<string, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  config_error: 422,
};

class HttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError || error instanceof LatticeServiceError) {
    const body: ApiErrorBody = { error: error.message, code: error.code };
    send(res, STATUS_BY_CODE[error.code] ?? 400, body);
    return;
  }
  const body: ApiErrorBody = {
    error: error instanceof Error ? error.message : String(error),
    code: "internal_error",
  };
  send(res, 500, body);
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = req.headers["content-type"] ?? "";
  if (!/^application\/json\b/i.test(type)) {
    // Also forces a CORS preflight for cross-site browser requests.
    throw new HttpError("unsupported_media_type", "content-type must be application/json");
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > limit) throw new HttpError("payload_too_large", `body exceeds ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError("invalid_request", "body is not valid JSON");
  }
}

function hostname(host: string | undefined): string {
  if (!host) return "";
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":")[0]!;
}

function tokensMatch(expected: string, header: string | undefined): boolean {
  const presented = header?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

function positiveInt(value: string | null, name: string): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HttpError("invalid_request", `${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * The daemon HTTP API. Binds nothing itself; see `startLatticeServer`.
 *
 * GET  /health
 * GET  /v1/tasks            list runs          (?cwd, ?limit)
 * POST /v1/tasks            run a task         {task, cwd?, mode?, configPath?}
 * GET  /v1/tasks/:id        run detail + TAP   (id, prefix or "latest")
 * GET  /v1/events/:id       raw run events
 * POST /v1/decide           bounded decision   {question, choices, state?, mode?, provider?, cwd?}
 * GET  /v1/reviews          pending remote reviews
 * GET  /v1/reviews/:runId   one pending review (run id, prefix or "latest")
 * POST /v1/reviews/:runId   answer it          {action, selected?, note?, reviewId?}
 * GET  /v1/stats            calibration stats
 * GET  /v1/doctor           environment checks (?network=false)
 */
export function createLatticeServer(options: LatticeServerOptions = {}): Server {
  const baseCwd = resolve(options.cwd ?? process.cwd());
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const defaultMode = options.defaultMode ?? "observe";
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;

  const projectDir = (value: unknown): string => {
    if (value === undefined || value === null || value === "") return baseCwd;
    if (typeof value !== "string") throw new HttpError("invalid_request", "cwd must be a string");
    return isAbsolute(value) ? value : resolve(baseCwd, value);
  };

  const activeRuns = new Set<string>();
  const reviews = new ReviewBroker({ timeoutMs: options.reviewTimeoutMs });

  /** Server-sent events: one `id: <seq>` / `data: <RunEvent json>` frame per event. */
  async function streamEvents(
    req: IncomingMessage,
    res: ServerResponse,
    reference: string,
    cwd: string,
    query: URLSearchParams,
  ): Promise<void> {
    // Resolve first so an unknown run is a normal JSON 404, not a broken stream.
    const runId = await resolveRunId(reference, cwd);
    const resumeFrom = query.get("after") ?? req.headers["last-event-id"];
    const after = resumeFrom === undefined || resumeFrom === null ? 0 : Number(resumeFrom);
    if (!Number.isInteger(after) || after < 0) {
      throw new HttpError("invalid_request", "after/Last-Event-ID must be a non-negative integer");
    }

    const controller = new AbortController();
    req.on("close", () => controller.abort());
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(": lattice run events\n\n");
    const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15_000);
    try {
      for await (const event of followRunEvents(runId, cwd, { after, signal: controller.signal })) {
        res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS-rebinding and cross-site protections for a localhost-only daemon.
    if (!LOCAL_HOSTS.has(hostname(req.headers.host))) {
      throw new HttpError("forbidden", "host not allowed");
    }
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      throw new HttpError("forbidden", "origin not allowed");
    }
    if (origin) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
    }
    if (req.method === "OPTIONS" && origin) {
      res.writeHead(204, {
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "content-type, authorization",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health") {
      if (req.method !== "GET") throw new HttpError("method_not_allowed", "use GET");
      send(res, 200, {
        ok: true,
        service: "lattice",
        version: LATTICE_VERSION,
        activeRuns: activeRuns.size,
      });
      return;
    }

    if (options.token && !tokensMatch(options.token, req.headers.authorization)) {
      throw new HttpError("unauthorized", "missing or invalid bearer token");
    }

    const query = url.searchParams;
    const [, v1, resource, id, ...rest] = path.split("/");
    if (v1 !== "v1" || rest.length > 0) throw new HttpError("not_found", `no route for ${path}`);
    const method = req.method ?? "GET";
    const expect = (allowed: string) => {
      if (method !== allowed) throw new HttpError("method_not_allowed", `use ${allowed}`);
    };

    switch (resource) {
      case "tasks": {
        if (id) {
          expect("GET");
          send(res, 200, await getRun(decodeURIComponent(id), projectDir(query.get("cwd"))));
          return;
        }
        if (method === "GET") {
          send(res, 200, {
            runs: await listRuns({
              cwd: projectDir(query.get("cwd")),
              limit: positiveInt(query.get("limit"), "limit"),
            }),
          });
          return;
        }
        expect("POST");
        const body = (await readJson(req, maxBodyBytes)) as Record<string, unknown>;
        if (body.configPath !== undefined && typeof body.configPath !== "string") {
          throw new HttpError("invalid_request", "configPath must be a string");
        }
        if (body.wait !== undefined && typeof body.wait !== "boolean") {
          throw new HttpError("invalid_request", "wait must be a boolean");
        }
        const review = body.review ?? "none";
        if (review !== "none" && review !== "remote") {
          throw new HttpError("invalid_request", "review must be 'none' or 'remote'");
        }
        const cwd = projectDir(body.cwd);
        let runId: string | undefined;
        const taskOptions = {
          cwd,
          mode: (body.mode as TaskExecutionMode | undefined) ?? defaultMode,
          intent: body.intent as TaskIntent | undefined,
          configPath: body.configPath as string | undefined,
          reviewer: review === "remote" ? reviews.reviewerFor(() => runId) : undefined,
          onEvent: (event: { runId: string }) => {
            runId ??= event.runId;
          },
        };

        if (body.wait === false) {
          const started = await startTask(body.task as string, taskOptions);
          activeRuns.add(started.runId);
          void started.done.finally(() => activeRuns.delete(started.runId));
          const cwdParam = body.cwd ? `cwd=${encodeURIComponent(cwd)}` : "";
          const accepted: TaskAccepted = {
            runId: started.runId,
            status: "running",
            startedAt: started.startedAt,
            mode: taskOptions.mode,
            links: {
              run: `/v1/tasks/${started.runId}${cwdParam ? `?${cwdParam}` : ""}`,
              events: `/v1/events/${started.runId}?follow=true${cwdParam ? `&${cwdParam}` : ""}`,
            },
          };
          send(res, 202, accepted);
          return;
        }

        const outcome = await executeTask(body.task as string, taskOptions);
        send(res, 201, {
          ...outcome.result,
          mode: outcome.mode,
          intent: outcome.intent,
          runtimeMode: outcome.runtimeMode,
          configPath: outcome.configPath,
        });
        return;
      }
      case "events": {
        expect("GET");
        if (!id) throw new HttpError("not_found", "run id required");
        const wantsStream =
          query.get("follow") === "true" ||
          /\btext\/event-stream\b/.test(req.headers.accept ?? "");
        if (wantsStream) {
          await streamEvents(req, res, decodeURIComponent(id), projectDir(query.get("cwd")), query);
          return;
        }
        send(res, 200, {
          events: await getRunEvents(decodeURIComponent(id), projectDir(query.get("cwd"))),
        });
        return;
      }
      case "decide": {
        expect("POST");
        if (id) throw new HttpError("not_found", `no route for ${path}`);
        const body = (await readJson(req, maxBodyBytes)) as Record<string, unknown>;
        const provider = body.provider ?? "configured";
        if (provider !== "configured" && provider !== "random") {
          throw new HttpError("invalid_request", "provider must be 'configured' or 'random'");
        }
        send(
          res,
          200,
          await decide(parseDecisionRequest(body), {
            cwd: projectDir(body.cwd),
            provider,
          }),
        );
        return;
      }
      case "reviews": {
        if (!id) {
          expect("GET");
          send(res, 200, { reviews: reviews.list() });
          return;
        }
        const reference = decodeURIComponent(id);
        if (method === "GET") {
          send(res, 200, reviews.get(reference));
          return;
        }
        expect("POST");
        const answered = reviews.answer(reference, await readJson(req, maxBodyBytes));
        send(res, 200, { runId: answered.runId, reviewId: answered.reviewId, accepted: true });
        return;
      }
      case "stats": {
        expect("GET");
        send(res, 200, await getStats(projectDir(query.get("cwd"))));
        return;
      }
      case "doctor": {
        expect("GET");
        send(
          res,
          200,
          await runDoctor({
            cwd: projectDir(query.get("cwd")),
            network: query.get("network") !== "false",
          }),
        );
        return;
      }
      default:
        throw new HttpError("not_found", `no route for ${path}`);
    }
  }

  return createServer((req, res) => {
    route(req, res).catch((error) => {
      if (!res.headersSent) sendError(res, error);
      else res.end();
    });
  });
}

export interface StartedLatticeServer {
  server: Server;
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Listen on 127.0.0.1 (never a public interface). Port 0 picks a free port. */
export async function startLatticeServer(
  options: LatticeServerOptions & { port?: number } = {},
): Promise<StartedLatticeServer> {
  const server = createLatticeServer(options);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4774, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
        // Open SSE streams would otherwise keep close() pending indefinitely.
        server.closeAllConnections();
      }),
  };
}
