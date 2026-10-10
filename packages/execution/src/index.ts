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

/**
 * The environment commands inherit. `NODE_TEST_CONTEXT` is set by Node's own test
 * runner; if it leaks into a child `node --test`, that child exits 0 WITHOUT running
 * any test, so a verifier would "pass" vacuously. Commands run by Lattice are
 * independent programs, so they never inherit the parent's test-runner context
 * (a caller can still set it explicitly through `spec.env`).
 */
function inheritedEnv(): NodeJS.ProcessEnv {
  const { NODE_TEST_CONTEXT: _testContext, ...rest } = process.env;
  return rest;
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
      stdio: [spec.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...inheritedEnv(), ...spec.env },
    });

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

    child.once("error", reject);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
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

export {
  classifyAppType,
  classifyPlatforms,
  classifyTask,
  fingerprintProject,
  type ManifestFact,
  type ProjectFingerprint,
  type StackTag,
  type TaskClass,
} from "./fingerprint.js";

export * from "./fidelity.js";
