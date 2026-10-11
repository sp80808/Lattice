/**
 * Google Colab remote batch execution backend.
 *
 * Colab is an *optional remote batch execution* backend, not an assumed
 * Ollama or OpenAI-compatible server. Sessions are discovered from the
 * official `colab` CLI at call time; no session name is ever hardcoded into
 * orchestration. A stale session name resolves to `stale`, not to a crash or a
 * silent substitution onto another session.
 */

import { spawnSync } from "node:child_process";

export type SessionAccelerator = "cpu" | "gpu" | "tpu" | "unknown";

/** The workload class a session is fit for. Drives the scheduler. */
export type SessionClass = "gpu-training" | "gpu-benchmark" | "cpu-verification" | "cpu-inference" | "idle" | "stale";

export interface ColabSession {
  name: string;
  /** Opaque endpoint id assigned by Colab. */
  endpoint: string;
  accelerator: SessionAccelerator;
  /** Human-readable accelerator name as reported, e.g. "T4", "NONE". */
  acceleratorLabel: string;
  shape?: string;
  variant?: string;
  url?: string;
}

export interface ColabUsage {
  /** Remaining compute units. */
  balanceUnits: number;
  /** Compute units burned per hour right now. */
  usageRatePerHour: number;
  activeAssignments: number;
}

export interface ColabRunnerOptions {
  /** Path to the `colab` executable. */
  executable?: string;
  /** Injectable for tests and dry runs. */
  exec?: (args: string[], input?: string) => { status: number; stdout: string; stderr: string };
}

export class ColabCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly status: number,
    readonly stderr: string,
  ) {
    super(`colab ${args.join(" ")} failed (exit ${status}): ${stderr.trim().slice(0, 300)}`);
    this.name = "ColabCommandError";
  }
}

export class ColabClient {
  private readonly executable: string;
  private readonly run: (args: string[], input?: string) => { status: number; stdout: string; stderr: string };

  constructor(options: ColabRunnerOptions = {}) {
    this.executable = options.executable ?? "colab";
    this.run =
      options.exec ??
      ((args, input) => {
        const result = spawnSync(this.executable, args, {
          encoding: "utf8",
          input,
          maxBuffer: 64 * 1024 * 1024,
        });
        return {
          status: result.status ?? (result.error ? 1 : 0),
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? String(result.error ?? ""),
        };
      });
  }

  /** List sessions the CLI currently reports as active. Never a cached list. */
  sessions(): ColabSession[] {
    const { status, stdout, stderr } = this.run(["sessions"]);
    if (status !== 0) throw new ColabCommandError(["sessions"], status, stderr);
    return parseSessions(stdout);
  }

  usage(): ColabUsage {
    const { status, stdout, stderr } = this.run(["usage"]);
    if (status !== 0) throw new ColabCommandError(["usage"], status, stderr);
    return parseUsage(stdout);
  }

  /** Resolve one session by name. Returns null when the name is stale. */
  session(name: string): ColabSession | null {
    return this.sessions().find((s) => s.name === name) ?? null;
  }

  /** Status of one named session, tolerant of stale names. */
  status(name: string): { session: ColabSession | null; stale: boolean } {
    const session = this.session(name);
    return { session, stale: session === null };
  }

  /** Run a Python script inside a session. */
  exec(session: string, script: string, timeoutSeconds = 60): string {
    const args = ["exec", "-s", session, "--timeout", String(timeoutSeconds)];
    const { status, stdout, stderr } = this.run(args, script);
    if (status !== 0) throw new ColabCommandError(args, status, stderr);
    return stdout;
  }

  /** Download a remote artifact into the local artifact store. */
  download(session: string, remotePath: string, localPath: string): void {
    const args = ["download", "-s", session, remotePath, localPath];
    const { status, stderr } = this.run(args);
    if (status !== 0) throw new ColabCommandError(args, status, stderr);
  }

  ls(session: string, remotePath: string): string[] {
    const args = ["ls", "-s", session, remotePath];
    const { status, stdout, stderr } = this.run(args);
    if (status !== 0) throw new ColabCommandError(args, status, stderr);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("[") && !line.startsWith("Usage:"));
  }

  stop(session: string): void {
    const args = ["stop", "-s", session];
    const { status, stdout, stderr } = this.run(args);
    // A session that already vanished is not an error for a stop request.
    const combined = `${stdout}${stderr}`.toLowerCase();
    if (status !== 0 && !/not found|no such|does not exist|unknown session/.test(combined)) {
      throw new ColabCommandError(args, status, stderr);
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const SESSION_LINE =
  /^\[([^\]]+)\]\s+(\S+)\s*(?:\|\s*Hardware:\s*([^|]+?))?\s*(?:\|\s*Shape:\s*([^|]+?))?\s*(?:\|\s*Variant:\s*([^|]+?))?\s*$/;

/** Output of `colab sessions` when no runtime is active. */
export const NO_SESSIONS_OUTPUT = "[colab] No active sessions found on server.";

export function parseSessions(output: string): ColabSession[] {
  const sessions: ColabSession[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    // `colab sessions` prints "[colab] No active sessions found on server."
    // and other diagnostic banners with the same bracket prefix. Only lines
    // that also carry an endpoint id and a Hardware field are real sessions.
    if (!line.startsWith("[") || /no active sessions|not found|unavailable|error/i.test(line)) continue;
    const match = SESSION_LINE.exec(line);
    if (!match) continue;
    const [, name, endpoint, hardware, shape, variant] = match;
    if (!endpoint || /\bHardware\b/.test(endpoint)) continue;
    const acceleratorLabel = hardware ?? "";
    sessions.push({
      name: name!,
      endpoint: endpoint!,
      accelerator: classifyAccelerator(acceleratorLabel),
      acceleratorLabel,
      shape,
      variant,
    });
  }
  return sessions;
}

export function classifyAccelerator(label: string): SessionAccelerator {
  const normalized = label.trim().toUpperCase();
  if (!normalized || normalized === "NONE" || normalized === "CPU" || normalized === "N/A") return "cpu";
  if (/^(T4|A100|L4|V100|P100|K80|H100|B200|GPU)/.test(normalized)) return "gpu";
  if (/TPU/.test(normalized)) return "tpu";
  return "unknown";
}

export function parseUsage(output: string): ColabUsage {
  const balance = /Current balance:\s*([\d.]+)/.exec(output);
  const rate = /Usage rate:\s*([\d.]+)\s*\/\s*hr/i.exec(output);
  const assignments = /Active assignments:\s*(\d+)/.exec(output);
  return {
    balanceUnits: balance ? Number(balance[1]) : Number.NaN,
    usageRatePerHour: rate ? Number(rate[1]) : Number.NaN,
    activeAssignments: assignments ? Number(assignments[1]) : Number.NaN,
  };
}

/**
 * Classify what a session is fit for from its accelerator plus observed
 * activity. CPU sessions running compilers/tests are `cpu-verification`; CPU
 * sessions loading models are `cpu-inference` and are a scheduling mistake.
 */
export function classifySession(
  session: ColabSession,
  observed?: { gpuUtilizationPct?: number; cpuLoad?: number; modelProcessRunning?: boolean; testProcessRunning?: boolean },
): SessionClass {
  if (session.accelerator === "gpu") {
    if ((observed?.gpuUtilizationPct ?? 0) > 5) return "gpu-training";
    return "gpu-benchmark";
  }
  if (observed?.modelProcessRunning) return "cpu-inference";
  if (observed?.testProcessRunning) return "cpu-verification";
  if ((observed?.cpuLoad ?? 0) > 0.5) return "cpu-verification";
  return "idle";
}

/** Compute units per hour a session class is expected to consume. */
export const CLASS_COMPUTE_UNITS_PER_HOUR: Record<SessionClass, number> = {
  "gpu-training": 2.0,
  "gpu-benchmark": 2.0,
  "cpu-verification": 0,
  "cpu-inference": 0.075,
  idle: 0.075,
  stale: 0,
};
