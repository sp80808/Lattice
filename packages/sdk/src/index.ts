/**
 * Typed client for the Lattice daemon HTTP API.
 *
 * Zero runtime dependencies: uses the platform `fetch`, so it runs on
 * Node >= 18, Deno, Bun and browsers (subject to the daemon's origin policy).
 */
import type { StatsReport } from "@lattice/analytics";
import type {
  ApiErrorBody,
  DecisionChoice,
  DecisionMode,
  DecisionResult,
  DoctorReport,
  PendingReview,
  ReviewAnswer,
  RunDetail,
  RunEvent,
  RunResult,
  RunSummary,
  TaskAccepted,
  TaskExecutionMode,
} from "@lattice/protocol";

export type {
  DecisionChoice,
  DecisionResult,
  DoctorCheck,
  DoctorReport,
  EvidenceRef,
  PendingReview,
  ReviewAnswer,
  RunDetail,
  RunEvent,
  RunResult,
  RunSummary,
  TapPacket,
  TaskAccepted,
  TaskExecutionMode,
} from "@lattice/protocol";
export type { StatsReport } from "@lattice/analytics";

export const DEFAULT_LATTICE_URL = "http://127.0.0.1:4774";

export interface LatticeClientOptions {
  /** Daemon base URL. Defaults to $LATTICE_URL, then http://127.0.0.1:4774. */
  baseUrl?: string;
  /** Bearer token when the daemon was started with one. Defaults to $LATTICE_DAEMON_TOKEN. */
  token?: string;
  /** Per-request timeout. Task runs can be long; default 10 minutes. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface ProjectOptions {
  /** Project directory on the daemon host. Defaults to the daemon's own cwd. */
  cwd?: string;
}

export interface RunTaskOptions extends ProjectOptions {
  /** `observe` (daemon default) never launches model search or coding agents. */
  mode?: TaskExecutionMode;
  configPath?: string;
  /** `remote`: supervised/manual reviews wait for `answerReview` instead of blocking the run. */
  review?: "none" | "remote";
}

export interface TaskRunResponse extends RunResult {
  mode: TaskExecutionMode;
  runtimeMode: "auto" | "observe" | "evidence-only";
  configPath?: string;
}

export interface StreamOptions extends ProjectOptions {
  /** Resume after this event `seq`. */
  after?: number;
  signal?: AbortSignal;
}

export interface DecideInput extends ProjectOptions {
  question: string;
  choices: DecisionChoice[];
  state?: string;
  mode?: DecisionMode;
  allowUnknown?: boolean;
  /** `configured` uses the project's decision model; `random` is an offline baseline. */
  provider?: "configured" | "random";
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
  /** Runs started with `submitTask` that are still in progress. */
  activeRuns?: number;
}

/** Non-2xx daemon response. `code` is stable; `message` is for humans. */
export class LatticeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LatticeApiError";
  }
}

function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

export class LatticeClient {
  readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LatticeClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? env("LATTICE_URL") ?? DEFAULT_LATTICE_URL).replace(/\/+$/, "");
    this.token = options.token ?? env("LATTICE_DAEMON_TOKEN");
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  health(): Promise<HealthResponse> {
    return this.request("GET", "/health");
  }

  /** Resolve once the daemon answers /health, or throw after `timeoutMs`. */
  async waitUntilReady(timeoutMs = 10_000, intervalMs = 200): Promise<HealthResponse> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        return await this.health();
      } catch (error) {
        last = error;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
    throw new Error(
      `Lattice daemon at ${this.baseUrl} not ready after ${timeoutMs}ms: ${last instanceof Error ? last.message : String(last)}`,
    );
  }

  runTask(task: string, options: RunTaskOptions = {}): Promise<TaskRunResponse> {
    return this.request("POST", "/v1/tasks", { task, ...options });
  }

  /** Start a task and return as soon as it is running (HTTP 202). */
  submitTask(task: string, options: RunTaskOptions = {}): Promise<TaskAccepted> {
    return this.request("POST", "/v1/tasks", { task, ...options, wait: false });
  }

  /**
   * Stream a run's events (server-sent events) until it completes or fails.
   * Replays earlier events first, so it is safe to call after `submitTask`.
   */
  async *streamEvents(id: string, options: StreamOptions = {}): AsyncGenerator<RunEvent> {
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/events/${encodeURIComponent(id)}` +
        query({ follow: "true", cwd: options.cwd, after: options.after }),
      { headers, signal: options.signal },
    );
    if (!response.ok || !response.body) {
      const text = await response.text();
      let error: Partial<ApiErrorBody> | undefined;
      try {
        error = JSON.parse(text) as Partial<ApiErrorBody>;
      } catch {
        error = undefined;
      }
      throw new LatticeApiError(response.status, error?.code ?? "http_error", error?.error ?? `HTTP ${response.status}`);
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (data) yield JSON.parse(data) as RunEvent;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  /** Follow a run to completion and return its final detail. */
  async waitForRun(id: string, options: StreamOptions = {}): Promise<RunDetail> {
    let runId = id;
    for await (const event of this.streamEvents(id, options)) runId = event.runId;
    return this.getRun(runId, { cwd: options.cwd });
  }

  /** Reviews waiting for an answer on this daemon (runs submitted with `review: "remote"`). */
  async listReviews(): Promise<PendingReview[]> {
    return (await this.request<{ reviews: PendingReview[] }>("GET", "/v1/reviews")).reviews;
  }

  /** `runId` may be a full ID, an unambiguous prefix, or `latest`. */
  getReview(runId: string): Promise<PendingReview> {
    return this.request("GET", `/v1/reviews/${encodeURIComponent(runId)}`);
  }

  /** Answer a pending review; pass `reviewId` to guard against answering a stale round. */
  answerReview(
    runId: string,
    answer: ReviewAnswer,
  ): Promise<{ runId: string; reviewId: string; accepted: true }> {
    return this.request("POST", `/v1/reviews/${encodeURIComponent(runId)}`, answer);
  }

  /** Poll until `runId` has a pending review, or throw after `timeoutMs`. */
  async waitForReview(
    runId: string,
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<PendingReview> {
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    while (true) {
      try {
        return await this.getReview(runId);
      } catch (error) {
        if (!(error instanceof LatticeApiError && error.status === 404) || Date.now() > deadline) throw error;
      }
      await new Promise((r) => setTimeout(r, options.intervalMs ?? 200));
    }
  }

  async listRuns(options: ProjectOptions & { limit?: number } = {}): Promise<RunSummary[]> {
    const body = await this.request<{ runs: RunSummary[] }>(
      "GET",
      "/v1/tasks" + query({ cwd: options.cwd, limit: options.limit }),
    );
    return body.runs;
  }

  /** `id` may be a full run ID, an unambiguous prefix, or `latest`. */
  getRun(id: string, options: ProjectOptions = {}): Promise<RunDetail> {
    return this.request("GET", `/v1/tasks/${encodeURIComponent(id)}` + query({ cwd: options.cwd }));
  }

  async getEvents(id: string, options: ProjectOptions = {}): Promise<RunEvent[]> {
    const body = await this.request<{ events: RunEvent[] }>(
      "GET",
      `/v1/events/${encodeURIComponent(id)}` + query({ cwd: options.cwd }),
    );
    return body.events;
  }

  decide(input: DecideInput): Promise<DecisionResult> {
    return this.request("POST", "/v1/decide", input);
  }

  stats(options: ProjectOptions = {}): Promise<StatsReport> {
    return this.request("GET", "/v1/stats" + query({ cwd: options.cwd }));
  }

  doctor(options: ProjectOptions & { network?: boolean } = {}): Promise<DoctorReport> {
    return this.request(
      "GET",
      "/v1/doctor" +
        query({ cwd: options.cwd, network: options.network === false ? "false" : undefined }),
    );
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const response = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const error = parsed as Partial<ApiErrorBody> | undefined;
      throw new LatticeApiError(
        response.status,
        error?.code ?? "http_error",
        error?.error ?? `HTTP ${response.status}: ${text.slice(0, 200)}`,
      );
    }
    return parsed as T;
  }
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
