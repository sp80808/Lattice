/**
 * Record/replay boundary for a run's non-deterministic I/O (#51).
 *
 * In `record` mode every model call, verify command, structured verifier and
 * experiment passes through live and its canonical request plus response is
 * appended to a cassette. In `replay` mode nothing live is ever called: each
 * call must match the next recorded request of the same kind, in call order,
 * and gets the recorded response. The first mismatch or missing entry throws
 * a `ReplayDivergenceError` naming the call and the request fields that
 * changed, so a divergence is localized instead of surfacing as a final diff.
 *
 * Cassettes hold prompts, model replies and command output. They live next to
 * the run log under `.lattice/runs/` and are never sent anywhere.
 */
import { appendFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { CommandResult, CommandSpec } from "@lattice/execution";
import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  GeneratorProvider,
  GeneratorRequest,
  GeneratorResult,
  TapPacket,
  VerificationRecord,
  Verifier,
} from "@lattice/protocol";
import type {
  CandidateAction,
  ExperimentExecutor,
  ExperimentOutcome,
} from "@lattice/search";

export const CASSETTE_SCHEMA = "lattice.cassette/v1" as const;

export type CassetteKind = "generator" | "decision" | "command" | "verifier" | "experiment";

export interface CassetteEntry {
  schema: typeof CASSETTE_SCHEMA;
  /** Call order within the run, assigned when the call starts. */
  seq: number;
  kind: CassetteKind;
  /** sha256 of the canonical request. */
  request: string;
  /** The canonical request itself, so a divergence can name changed fields. */
  requestBody: unknown;
  response?: unknown;
  /** Set when the live call threw; replay throws the same message. */
  error?: string;
}

export class ReplayDivergenceError extends Error {
  constructor(
    readonly seq: number,
    readonly kind: CassetteKind,
    readonly reason: "missing" | "kind" | "request",
    readonly expected?: { kind: CassetteKind; request: string },
    readonly actual?: { kind: CassetteKind; request: string },
    readonly changedFields: string[] = [],
  ) {
    super(
      reason === "missing"
        ? `replay diverged at call ${seq}: no recorded ${kind} call (the recorded run made fewer calls)`
        : reason === "kind"
          ? `replay diverged at call ${seq}: expected a ${expected!.kind} call, got ${kind}`
          : `replay diverged at call ${seq} (${kind}): request changed in ${changedFields.join(", ") || "unknown fields"}`,
    );
    this.name = "ReplayDivergenceError";
  }
}

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

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function changedFields(expected: unknown, actual: unknown): string[] {
  if (!expected || !actual || typeof expected !== "object" || typeof actual !== "object") {
    return [];
  }
  const a = expected as Record<string, unknown>;
  const b = actual as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => canonical(a[key]) !== canonical(b[key]))
    .sort();
}

export interface CassetteIo {
  /** Wraps one non-deterministic call. */
  call<T>(kind: CassetteKind, requestBody: unknown, live: () => Promise<T>): Promise<T>;
  /** Replay only: throws if recorded calls were never consumed. */
  assertConsumed(): void;
}

/**
 * Record live calls to `path` (one JSON line per completed call). `path` may
 * be a function so the file can be named after a run ID that is only known
 * once the run starts; it is resolved at the first write.
 */
export function recordCassette(path: string | (() => string)): CassetteIo {
  let seq = 0;
  let writes: Promise<void> = Promise.resolve();
  return {
    async call<T>(kind: CassetteKind, requestBody: unknown, live: () => Promise<T>): Promise<T> {
      const mySeq = ++seq;
      const body = JSON.parse(canonical(requestBody)) as unknown;
      const entry: CassetteEntry = {
        schema: CASSETTE_SCHEMA,
        seq: mySeq,
        kind,
        request: sha256(canonical(body)),
        requestBody: body,
      };
      let response: T;
      try {
        response = await live();
        entry.response = response;
      } catch (error) {
        // Failures are recorded too, or every later call would shift by one.
        entry.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        writes = writes.then(() => appendFile(typeof path === "string" ? path : path(), JSON.stringify(entry) + "\n", "utf8"));
        await writes;
      }
      return response;
    },
    assertConsumed() {},
  };
}

export async function loadCassette(path: string): Promise<CassetteEntry[]> {
  const entries: CassetteEntry[] = [];
  const raw = await readFile(path, "utf8");
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as CassetteEntry;
    if (entry.schema !== CASSETTE_SCHEMA) {
      // Fail closed: an unknown cassette cannot vouch for anything.
      throw new Error(`${path}:${index + 1}: unsupported cassette schema ${String(entry.schema)}`);
    }
    entries.push(entry);
  }
  return entries.sort((a, b) => a.seq - b.seq);
}

/** Serve recorded responses in call order; never calls `live`. */
export function replayCassette(entries: CassetteEntry[]): CassetteIo {
  let seq = 0;
  return {
    async call<T>(kind: CassetteKind, requestBody: unknown): Promise<T> {
      const mySeq = ++seq;
      const entry = entries[mySeq - 1];
      const body = JSON.parse(canonical(requestBody)) as unknown;
      const request = sha256(canonical(body));
      if (!entry) throw new ReplayDivergenceError(mySeq, kind, "missing");
      const expected = { kind: entry.kind, request: entry.request };
      if (entry.kind !== kind) {
        throw new ReplayDivergenceError(mySeq, kind, "kind", expected, { kind, request });
      }
      if (entry.request !== request) {
        throw new ReplayDivergenceError(
          mySeq,
          kind,
          "request",
          expected,
          { kind, request },
          changedFields(entry.requestBody, body),
        );
      }
      if (entry.error !== undefined) throw new Error(entry.error);
      return structuredClone(entry.response) as T;
    },
    assertConsumed() {
      if (seq < entries.length) {
        const next = entries[seq]!;
        throw new ReplayDivergenceError(
          next.seq,
          next.kind,
          "missing",
          { kind: next.kind, request: next.request },
          undefined,
        );
      }
    },
  };
}

export function cassetteGenerator(io: CassetteIo, live: GeneratorProvider): GeneratorProvider {
  return {
    generate: (request: GeneratorRequest) =>
      io.call<GeneratorResult>("generator", request, () => live.generate(request)),
  };
}

export function cassetteDecision(io: CassetteIo, live: DecisionProvider): DecisionProvider {
  return {
    decide: (request: DecisionRequest) =>
      io.call<DecisionResult>("decision", request, () => live.decide(request)),
  };
}

export function cassetteExecutor(io: CassetteIo, live: ExperimentExecutor): ExperimentExecutor {
  return {
    // The TAP carries timestamps; the candidate is the request identity, and
    // any change in what led to it already diverged at an earlier model call.
    execute: (candidate: CandidateAction, tap: TapPacket) =>
      io.call<ExperimentOutcome>("experiment", { candidate }, () => live.execute(candidate, tap)),
  };
}

export function cassetteVerifier(io: CassetteIo, live: Verifier): Verifier {
  return {
    tool: live.tool,
    describe: () => live.describe(),
    verify: (cwd: string) =>
      io.call<VerificationRecord>(
        "verifier",
        { tool: live.tool, describe: live.describe() },
        () => live.verify(cwd),
      ),
  };
}

export function cassetteCommandRunner(
  io: CassetteIo,
  live: (spec: CommandSpec) => Promise<CommandResult>,
): (spec: CommandSpec) => Promise<CommandResult> {
  return (spec) =>
    io.call<CommandResult>(
      "command",
      // cwd, timeouts and output caps do not change what was asked.
      { command: spec.command, args: spec.args ?? [], stdin: spec.stdin },
      () => live(spec),
    );
}
