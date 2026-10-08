import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

export interface CommandSpec {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  stdin?: string;
  env?: Record<string, string | undefined>;
  /**
   * `inherit` (default) passes the parent environment through, which is right
   * for trusted tooling such as git or the verifier. `minimal` passes only
   * {@link MINIMAL_ENV_BASE}, the names in `allowEnv` and explicit `env`
   * values, so an autonomous worker cannot read unrelated parent secrets.
   */
  envPolicy?: EnvPolicy;
  /** Extra parent variable names passed through under `envPolicy: "minimal"`. */
  allowEnv?: string[];
  /**
   * Run the command in its own process group and terminate the whole group on
   * timeout and once the command exits, so background descendants cannot
   * outlive it. A worker that calls setsid() itself escapes this; only a real
   * sandbox closes that gap.
   */
  killTree?: boolean;
  /** Grace period between SIGTERM and SIGKILL when a tree is killed. */
  killGraceMs?: number;
}

export type EnvPolicy = "inherit" | "minimal";

/**
 * Variables every minimal-environment worker receives: enough to find
 * binaries, decode text and write temp files. HOME is deliberately absent;
 * adapters that keep login state there must declare it in `allowEnv`.
 */
export const MINIMAL_ENV_BASE: readonly string[] = [
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  // Windows cannot start most processes without these.
  "SYSTEMROOT",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
];

export interface CommandResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
  envPolicy: EnvPolicy;
  /** Names (never values) of the variables the command received. */
  envNames: string[];
  /** True when `killTree` found descendants still running and killed them. */
  descendantsKilled?: boolean;
}

export interface RepositorySnapshot {
  root: string;
  revision?: string;
  dirty?: boolean;
  trackedFiles: string[];
  source: "git" | "filesystem";
}

function appendLimited(
  current: string,
  chunk: Buffer,
  limit: number,
): { value: string; truncated: boolean } {
  if (Buffer.byteLength(current) >= limit) {
    return { value: current, truncated: true };
  }

  const remaining = Math.max(0, limit - Buffer.byteLength(current));
  const next = chunk.subarray(0, remaining).toString("utf8");
  return {
    value: current + next,
    truncated: chunk.byteLength > remaining,
  };
}

export function buildCommandEnv(
  policy: EnvPolicy,
  allow: readonly string[] = [],
  explicit: Record<string, string | undefined> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (policy === "inherit") {
    for (const [name, value] of Object.entries(source)) {
      if (value !== undefined) env[name] = value;
    }
  } else {
    for (const name of [...MINIMAL_ENV_BASE, ...allow]) {
      const value = source[name];
      if (value !== undefined) env[name] = value;
    }
  }
  for (const [name, value] of Object.entries(explicit)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

const liveGroups = new Set<number>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Detached groups do not receive the terminal's signals, so take them down
  // with us when Lattice itself exits.
  process.once("exit", () => {
    for (const pid of liveGroups) signalGroup(pid, "SIGKILL");
  });
}

/** Sends a signal to a process group; false when the group no longer exists. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function killWindowsTree(pid: number): void {
  try {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).on("error", () => undefined);
  } catch {
    // Best effort: the direct child was already signalled.
  }
}

export async function runCommand(spec: CommandSpec): Promise<CommandResult> {
  const cwd = resolve(spec.cwd ?? process.cwd());
  const args = spec.args ?? [];
  const timeoutMs = spec.timeoutMs ?? 30_000;
  const maxOutputBytes = spec.maxOutputBytes ?? 256_000;
  const envPolicy = spec.envPolicy ?? "inherit";
  const env = buildCommandEnv(envPolicy, spec.allowEnv, spec.env);
  const killGraceMs = spec.killGraceMs ?? 2_000;
  const posixGroup = spec.killTree === true && process.platform !== "win32";
  const started = performance.now();

  return await new Promise<CommandResult>((resolvePromise, reject) => {
    const child = spawn(spec.command, args, {
      cwd,
      shell: false,
      stdio: [spec.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env,
      detached: posixGroup,
    });
    const groupPid = posixGroup ? child.pid : undefined;
    if (groupPid !== undefined) {
      liveGroups.add(groupPid);
      installExitHook();
    }

    if (spec.stdin !== undefined) {
      child.stdin?.end(spec.stdin);
    }

    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let timedOut = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      const appended = appendLimited(stdout, chunk, maxOutputBytes);
      stdout = appended.value;
      outputTruncated ||= appended.truncated;
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const appended = appendLimited(stderr, chunk, maxOutputBytes);
      stderr = appended.value;
      outputTruncated ||= appended.truncated;
    });

    let forceTimer: NodeJS.Timeout | undefined;

    child.once("error", (error) => {
      if (groupPid !== undefined) liveGroups.delete(groupPid);
      clearTimeout(timer);
      clearTimeout(forceTimer);
      reject(error);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (groupPid !== undefined) {
        signalGroup(groupPid, "SIGTERM");
        forceTimer = setTimeout(() => {
          signalGroup(groupPid, "SIGKILL");
          // A descendant that escaped the group can still hold our pipes open;
          // stop waiting on them so the timeout is actually bounded.
          setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
          }, 500).unref();
        }, killGraceMs);
        forceTimer.unref();
      } else {
        // taskkill walks the tree from the live parent, so it goes first.
        if (spec.killTree && child.pid !== undefined) killWindowsTree(child.pid);
        child.kill("SIGTERM");
      }
    }, timeoutMs);

    let descendantsKilled: boolean | undefined;
    child.once("exit", () => {
      if (groupPid === undefined) return;
      // The leader has exited; anything still in its group is a descendant it
      // left behind, possibly holding our pipes open.
      descendantsKilled = signalGroup(groupPid, "SIGKILL");
      liveGroups.delete(groupPid);
    });

    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolvePromise({
        command: spec.command,
        args,
        cwd,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: performance.now() - started,
        timedOut,
        outputTruncated,
        envPolicy,
        envNames: Object.keys(env).sort(),
        ...(descendantsKilled !== undefined ? { descendantsKilled } : {}),
      });
    });
  });
}

async function git(
  cwd: string,
  args: string[],
  timeoutMs = 5_000,
): Promise<CommandResult | undefined> {
  try {
    return await runCommand({
      command: "git",
      args,
      cwd,
      timeoutMs,
      maxOutputBytes: 512_000,
    });
  } catch {
    return undefined;
  }
}

export async function collectRepositorySnapshot(
  cwdInput: string,
  maxFiles = 2_000,
): Promise<RepositorySnapshot> {
  const root = resolve(cwdInput);
  const revisionResult = await git(root, ["rev-parse", "HEAD"]);

  if (revisionResult?.exitCode === 0) {
    const filesResult = await git(root, ["ls-files"]);
    const statusResult = await git(root, ["status", "--porcelain"]);
    const trackedFiles =
      filesResult?.exitCode === 0
        ? filesResult.stdout
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean)
            .slice(0, maxFiles)
        : [];

    return {
      root,
      revision: revisionResult.stdout.trim() || undefined,
      dirty: Boolean(statusResult?.stdout.trim()),
      trackedFiles,
      source: "git",
    };
  }

  const entries = await readdir(root, { withFileTypes: true });
  return {
    root,
    trackedFiles: entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
      .slice(0, maxFiles),
    source: "filesystem",
  };
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
