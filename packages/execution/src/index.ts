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
  /** sha256 of the complete stdout stream, including any truncated tail. */
  stdoutSha256: string;
  /** sha256 of the complete stderr stream, including any truncated tail. */
  stderrSha256: string;
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
      env: { ...process.env, ...spec.env },
    });

    if (spec.stdin !== undefined) {
      child.stdin?.end(spec.stdin);
    }

    let stdout = "";
    let stderr = "";
    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    let outputTruncated = false;
    let timedOut = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutHash.update(chunk);
      const appended = appendLimited(stdout, chunk, maxOutputBytes);
      stdout = appended.value;
      outputTruncated ||= appended.truncated;
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrHash.update(chunk);
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
        stdoutSha256: stdoutHash.digest("hex"),
        stderrSha256: stderrHash.digest("hex"),
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

/** JSON with object keys sorted, so equal values always hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : item,
  );
}

/**
 * Deterministic identity for a command observation: what ran, against which
 * revision, and its complete outputs. Duration, timestamps, cwd and display
 * text are deliberately excluded so repeated equivalent runs share an ID.
 */
export function commandEvidenceIdentity(
  result: CommandResult,
  revision?: string,
): { id: string; identity: EvidenceIdentityV1 } {
  const request = digest(
    canonicalJson({ tool: "command", command: result.command, args: result.args }),
  );
  const outcome = digest(
    canonicalJson({
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      outputTruncated: result.outputTruncated,
      stdout: result.stdoutSha256,
      stderr: result.stderrSha256,
    }),
  );
  return evidenceIdentityV1("command", { revision, request, result: outcome });
}

export interface EvidenceIdentityV1 {
  scheme: "lattice.evidence/v1";
  revision?: string;
  request: string;
  result: string;
}

/** `ev1:` IDs live apart from legacy `ev:` IDs, so the two never collide. */
export function evidenceIdentityV1(
  kind: string,
  parts: { revision?: string; request: string; result: string },
): { id: string; identity: EvidenceIdentityV1 } {
  const identity: EvidenceIdentityV1 = {
    scheme: "lattice.evidence/v1",
    ...(parts.revision ? { revision: parts.revision } : {}),
    request: parts.request,
    result: parts.result,
  };
  const id = `ev1:${digest(canonicalJson({ kind, ...identity })).slice(0, 24)}`;
  return { id, identity };
}
