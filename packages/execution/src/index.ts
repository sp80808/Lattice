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
}

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

function killProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  // Kill the whole process group when we spawned detached, so grandchildren
  // (e.g. `sleep` under a bash wrapper) cannot outlive the timeout.
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through if the group is already gone or not detachable.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already exited
  }
}

export async function runCommand(spec: CommandSpec): Promise<CommandResult> {
  const cwd = resolve(spec.cwd ?? process.cwd());
  const args = spec.args ?? [];
  const timeoutMs = spec.timeoutMs ?? 30_000;
  const maxOutputBytes = spec.maxOutputBytes ?? 256_000;
  const started = performance.now();

  return await new Promise<CommandResult>((resolvePromise, reject) => {
    const child = spawn(spec.command, args, {
      cwd,
      shell: false,
      // New session/process group so timeout can SIGTERM/SIGKILL the tree.
      detached: process.platform !== "win32",
      stdio: [spec.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env, ...spec.env },
    });

    if (spec.stdin !== undefined) {
      child.stdin?.end(spec.stdin);
    }

    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let timedOut = false;
    let killEscalation: NodeJS.Timeout | undefined;

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

    child.once("error", reject);

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGTERM");
      killEscalation = setTimeout(() => {
        killProcessTree(child, "SIGKILL");
      }, 1_000);
    }, timeoutMs);

    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killEscalation) clearTimeout(killEscalation);
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
