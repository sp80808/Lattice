// Lattice side of Tessera issue #41: run the real `tsr witness`, keep its
// `tessera.witness/v0` document verbatim as evidence, and re-derive the
// verdict from a stored document without re-running or scraping CLI text.
//
// The contract lives in Tessera's docs/spec/witness.md. The verdict comes only
// from the document and the process exit code; a model never supplies it.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { runCommand, type CommandResult } from "@lattice/execution";
import type {
  EvidenceRef,
  VerificationRecord,
  Verifier,
} from "@lattice/protocol";

export const WITNESS_SCHEMA = "tessera.witness/v0" as const;
export const VERIFICATION_SCHEMA = "lattice.tessera-verification/v0" as const;

export type WitnessPhase = "check" | "mir" | "backend";
export type OverflowMode = "wrapping" | "trapping";
export type WitnessOutcome = "pass" | "fail" | "unsupported" | "tool_error";

/** Exit code `tsr witness` uses for each outcome (2 is a usage error, no document). */
export const OUTCOME_EXIT: Record<WitnessOutcome, number> = {
  pass: 0,
  fail: 1,
  unsupported: 3,
  tool_error: 4,
};

export interface WitnessDiagnostic {
  phase: string;
  severity: string;
  code: string;
  message: string;
  span: { start: number; end: number } | null;
  line?: number | null;
  col?: number | null;
}

export interface WitnessRepresentation {
  sha256: string;
  bytes: number;
  tessera_tokens: number | null;
  tokenizers: Record<string, number>;
}

/** `tessera.witness/v0`. Unknown extra fields are kept; they are part of `result_id`. */
export interface WitnessDocument {
  schema: typeof WITNESS_SCHEMA;
  tool: {
    name: string;
    version: string;
    commit: string;
    dirty: boolean | null;
  };
  invocation: {
    phase: WitnessPhase;
    overflow: OverflowMode | null;
    input: "tc" | "tir";
    path: string;
  };
  outcome: WitnessOutcome;
  source: { sha256: string; bytes: number } | null;
  phases: Array<{ phase: string; status: string }>;
  diagnostics: WitnessDiagnostic[];
  artifacts: Record<string, unknown>;
  representations: Record<string, WitnessRepresentation>;
  error: string | null;
  result_id: string;
  timing: Record<string, number | null>;
  [extra: string]: unknown;
}

/**
 * What Lattice concludes from one witness run. `verified` means the verdict
 * came from a well-formed, self-consistent Tessera document; `tool_error`
 * (including anything Lattice could not trust) is never verified.
 */
export interface WitnessVerdict {
  outcome: WitnessOutcome;
  verified: boolean;
  /** Why the run is not trusted, when Lattice downgraded it to `tool_error`. */
  reason?: string;
}

export interface WitnessRun {
  command: string;
  args: string[];
  exitCode: number | null;
  verdict: WitnessVerdict;
  /** The document exactly as `tsr` printed it, parsed; absent when none was usable. */
  document?: WitnessDocument;
  stderr?: string;
  durationMs: number;
}

const OUTCOMES = new Set<string>(Object.keys(OUTCOME_EXIT));

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Compact JSON with recursively sorted keys: serde_json's default `Value` order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Recompute `result_id` the way `tsr` does: SHA-256 of the document without
 * `timing`, `invocation.path` and `result_id`.
 */
export function computeResultId(document: WitnessDocument): string {
  const stable: Record<string, unknown> = structuredClone(document);
  delete stable.timing;
  delete stable.result_id;
  if (isObject(stable.invocation)) delete stable.invocation.path;
  return `sha256:${createHash("sha256").update(canonicalJson(stable)).digest("hex")}`;
}

/** Parse and shape-check a witness document. Throws on anything off-contract. */
export function parseWitness(text: string): WitnessDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("tsr witness output is not JSON");
  }
  if (!isObject(value)) throw new Error("tsr witness output is not a JSON object");
  if (value.schema !== WITNESS_SCHEMA) {
    throw new Error(
      `unsupported witness schema ${JSON.stringify(value.schema)} (expected ${WITNESS_SCHEMA})`,
    );
  }
  if (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) {
    throw new Error(`unknown witness outcome ${JSON.stringify(value.outcome)}`);
  }
  for (const field of ["tool", "invocation", "artifacts", "representations", "timing"]) {
    if (!isObject(value[field])) throw new Error(`witness field ${field} must be an object`);
  }
  for (const field of ["phases", "diagnostics"]) {
    if (!Array.isArray(value[field])) throw new Error(`witness field ${field} must be an array`);
  }
  if (typeof value.result_id !== "string" || !value.result_id.startsWith("sha256:")) {
    throw new Error("witness result_id is missing");
  }
  return value as WitnessDocument;
}

/**
 * Decide what a witness run proves. The outcome must agree with the exit code
 * and the document must hash to its own `result_id`; otherwise it is treated
 * as a tool error rather than trusted.
 */
export function classifyWitness(
  document: WitnessDocument,
  exitCode: number | null,
): WitnessVerdict {
  const expected = OUTCOME_EXIT[document.outcome];
  if (exitCode !== expected) {
    return {
      outcome: "tool_error",
      verified: false,
      reason: `outcome ${document.outcome} disagrees with exit code ${exitCode} (expected ${expected})`,
    };
  }
  const recomputed = computeResultId(document);
  if (recomputed !== document.result_id) {
    return {
      outcome: "tool_error",
      verified: false,
      reason: `result_id mismatch: document says ${document.result_id}, content hashes to ${recomputed}`,
    };
  }
  if (document.outcome === "tool_error") {
    return {
      outcome: "tool_error",
      verified: false,
      reason: document.error ?? "tsr reported a tool error",
    };
  }
  return { outcome: document.outcome, verified: true };
}

export interface WitnessOptions {
  /** `tsr` executable (default `$TSR`, then `tsr` on PATH). */
  tsr?: string;
  phase?: WitnessPhase;
  overflow?: OverflowMode;
  timeoutMs?: number;
}

export function resolveTsr(explicit?: string): string {
  return explicit ?? process.env.TSR ?? "tsr";
}

export function witnessArgs(file: string, options: WitnessOptions = {}): string[] {
  const args = ["witness"];
  if (options.phase) args.push(`--phase=${options.phase}`);
  // `tsr witness` rejects --overflow outside --phase=mir (it only affects MIR).
  if (options.overflow && options.phase === "mir") args.push(`--overflow=${options.overflow}`);
  args.push(file);
  return args;
}

/** Run `tsr witness` on one file. Never throws for tool problems; they become `tool_error`. */
export async function runWitness(
  file: string,
  options: WitnessOptions & { cwd?: string } = {},
): Promise<WitnessRun> {
  const command = resolveTsr(options.tsr);
  const args = witnessArgs(file, options);
  const started = performance.now();
  let result: CommandResult;
  try {
    result = await runCommand({
      command,
      args,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 60_000,
      maxOutputBytes: 4_000_000,
    });
  } catch (error) {
    return {
      command,
      args,
      exitCode: null,
      verdict: {
        outcome: "tool_error",
        verified: false,
        reason: `could not start ${command}: ${error instanceof Error ? error.message : String(error)}`,
      },
      durationMs: performance.now() - started,
    };
  }

  const base = {
    command,
    args,
    exitCode: result.exitCode,
    stderr: result.stderr.trim() || undefined,
    durationMs: result.durationMs,
  };
  if (result.timedOut || result.outputTruncated) {
    return {
      ...base,
      verdict: {
        outcome: "tool_error",
        verified: false,
        reason: result.timedOut ? "tsr witness timed out" : "tsr witness output truncated",
      },
    };
  }
  let document: WitnessDocument;
  try {
    document = parseWitness(result.stdout);
  } catch (error) {
    const detail = result.stderr.trim() ? `; stderr: ${result.stderr.trim().slice(0, 300)}` : "";
    return {
      ...base,
      verdict: {
        outcome: "tool_error",
        verified: false,
        reason: `${error instanceof Error ? error.message : String(error)} (exit ${result.exitCode})${detail}`,
      },
    };
  }
  return { ...base, document, verdict: classifyWitness(document, result.exitCode) };
}

// ---------------------------------------------------------------------------
// Behavioural cases: `tsr run` prints the function's value and nothing else.

export interface RunCase {
  function: string;
  args: Array<string | number>;
  /** Expected stdout of `tsr run`, trimmed. */
  expect: string;
}

export interface RunCaseResult {
  function: string;
  args: string[];
  expect: string;
  actual: string | null;
  exitCode: number | null;
  passed: boolean;
  stderr?: string;
}

export async function runCase(
  file: string,
  testCase: RunCase,
  options: { tsr?: string; overflow: OverflowMode; cwd?: string; timeoutMs?: number },
): Promise<RunCaseResult> {
  const args = testCase.args.map(String);
  const command = resolveTsr(options.tsr);
  try {
    const result = await runCommand({
      command,
      args: ["run", `--overflow=${options.overflow}`, file, testCase.function, ...args],
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 60_000,
    });
    const actual = result.exitCode === 0 && !result.timedOut ? result.stdout.trim() : null;
    return {
      function: testCase.function,
      args,
      expect: testCase.expect,
      actual,
      exitCode: result.exitCode,
      passed: actual === testCase.expect.trim(),
      stderr: result.stderr.trim() || undefined,
    };
  } catch (error) {
    return {
      function: testCase.function,
      args,
      expect: testCase.expect,
      actual: null,
      exitCode: null,
      passed: false,
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Verifier: witness first, then behavioural cases only if the compiler passed.

export interface TesseraVerifySpec extends WitnessOptions {
  /** Program to verify, relative to the run's cwd unless absolute. */
  file: string;
  /** Behavioural checks through `tsr run`; they require `overflow`. */
  cases?: RunCase[];
}

/** What the run log stores for one verification; `replayVerification` re-derives it. */
export interface TesseraVerificationRecord {
  schema: typeof VERIFICATION_SCHEMA;
  file: string;
  witness: Omit<WitnessRun, "durationMs"> & { durationMs: number };
  cases: RunCaseResult[];
  /** Set when this record was served from the in-process cache for identical source. */
  cached?: boolean;
}

export function validateVerifySpec(spec: TesseraVerifySpec): void {
  if (typeof spec.file !== "string" || !spec.file.trim()) {
    throw new Error("tessera verify spec requires a file");
  }
  if (spec.phase && !["check", "mir", "backend"].includes(spec.phase)) {
    throw new Error("tessera phase must be check, mir or backend");
  }
  if (spec.overflow && spec.overflow !== "wrapping" && spec.overflow !== "trapping") {
    throw new Error("tessera overflow must be wrapping or trapping");
  }
  if (spec.phase === "mir" && !spec.overflow) {
    throw new Error("tessera phase=mir requires overflow (Tessera open question O1)");
  }
  if (spec.cases?.length) {
    if (!spec.overflow) throw new Error("tessera cases require overflow (tsr run has no default)");
    for (const c of spec.cases) {
      if (typeof c.function !== "string" || !Array.isArray(c.args) || typeof c.expect !== "string") {
        throw new Error("each tessera case needs function, args and expect");
      }
    }
  }
}

function shortCommit(commit: string | undefined): string {
  return commit && /^[0-9a-f]{40}$/.test(commit) ? commit.slice(0, 12) : commit ?? "unknown";
}

function diagnosticLine(d: WitnessDiagnostic): string {
  const at = d.line != null && d.col != null ? `${d.line}:${d.col}` : "-";
  return `${d.phase} ${d.code} ${at} ${d.message}`;
}

function evidenceId(parts: string[]): string {
  return `ev:${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 20)}`;
}

/** Evidence records for one verification: one `build` record, one `test` per case. */
export function verificationEvidence(record: TesseraVerificationRecord): EvidenceRef[] {
  const { witness } = record;
  const doc = witness.document;
  const createdAt = new Date().toISOString();
  const source = [witness.command, ...witness.args].join(" ");
  const summary = [
    `tsr_witness=${witness.verdict.outcome}`,
    doc ? `result_id=${doc.result_id.slice(0, 23)}` : undefined,
    doc ? `tsr=${doc.tool.version}@${shortCommit(doc.tool.commit)}${doc.tool.dirty ? "+dirty" : ""}` : undefined,
    doc?.source ? `source_sha256=${doc.source.sha256.slice(0, 12)}` : undefined,
    witness.verdict.reason ? `reason=${witness.verdict.reason}` : undefined,
    doc?.diagnostics.length
      ? `diagnostics: ${doc.diagnostics.map(diagnosticLine).join("; ")}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  const records: EvidenceRef[] = [
    {
      id: evidenceId(["tessera.witness", record.file, doc?.result_id ?? summary]),
      kind: "build",
      verified: witness.verdict.verified,
      source,
      summary,
      createdAt,
    },
  ];

  for (const c of record.cases) {
    const call = `${c.function}(${c.args.join(",")})`;
    records.push({
      id: evidenceId(["tessera.run", record.file, doc?.source?.sha256 ?? "", call, String(c.actual)]),
      kind: "test",
      verified: c.actual !== null || c.exitCode !== null,
      source: `tsr run ${call}`,
      summary: c.passed
        ? `${call}=${c.actual} as expected`
        : c.actual === null
          ? `${call} did not return (exit ${c.exitCode})${c.stderr ? `: ${c.stderr.slice(0, 200)}` : ""}`
          : `${call}=${c.actual} expected ${c.expect}`,
      createdAt,
    });
  }
  return records;
}

export function verificationPassed(record: TesseraVerificationRecord): boolean {
  return (
    record.witness.verdict.outcome === "pass" &&
    record.witness.verdict.verified &&
    record.cases.every((c) => c.passed)
  );
}

export function verificationSummary(record: TesseraVerificationRecord): string {
  const failed = record.cases.filter((c) => !c.passed).length;
  return [
    `witness=${record.witness.verdict.outcome}`,
    record.cases.length ? `cases=${record.cases.length - failed}/${record.cases.length}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

export function toVerificationRecord(record: TesseraVerificationRecord): VerificationRecord {
  return {
    tool: "tessera.witness",
    passed: verificationPassed(record),
    summary: verificationSummary(record),
    evidence: verificationEvidence(record),
    record,
  };
}

/** Run witness (and cases when it passes) for `spec.file` resolved against `cwd`. */
export async function verifyTessera(
  spec: TesseraVerifySpec,
  cwd: string,
): Promise<TesseraVerificationRecord> {
  validateVerifySpec(spec);
  const file = isAbsolute(spec.file) ? spec.file : resolve(cwd, spec.file);
  const witness = await runWitness(file, { ...spec, cwd });
  const cases: RunCaseResult[] = [];
  if (witness.verdict.outcome === "pass" && witness.verdict.verified) {
    for (const c of spec.cases ?? []) {
      cases.push(
        await runCase(file, c, { tsr: spec.tsr, overflow: spec.overflow!, cwd, timeoutMs: spec.timeoutMs }),
      );
    }
  }
  return { schema: VERIFICATION_SCHEMA, file: spec.file, witness, cases };
}

/** Lattice `Verifier` backed by `tsr witness`; plug into `runTask({ verifier })`. */
export function createWitnessVerifier(spec: TesseraVerifySpec): Verifier {
  validateVerifySpec(spec);
  return {
    tool: "tessera.witness",
    describe: () => ({
      command: resolveTsr(spec.tsr),
      args: witnessArgs(spec.file, spec),
      cases: spec.cases?.length ?? 0,
    }),
    async verify(cwd: string) {
      return toVerificationRecord(await verifyTessera(spec, cwd));
    },
  };
}

// ---------------------------------------------------------------------------
// Replay: re-derive verdicts from stored records, no `tsr` needed.

export interface ReplayedVerification {
  file: string;
  storedOutcome: WitnessOutcome;
  replayedOutcome: WitnessOutcome;
  resultId?: string;
  passed: boolean;
  /** Stored verdict and the one re-derived from the stored document agree. */
  consistent: boolean;
  reason?: string;
}

export function isVerificationRecord(value: unknown): value is TesseraVerificationRecord {
  return isObject(value) && value.schema === VERIFICATION_SCHEMA && isObject(value.witness);
}

export function replayVerification(record: TesseraVerificationRecord): ReplayedVerification {
  const stored = record.witness.verdict;
  let replayed: WitnessVerdict;
  if (record.witness.document) {
    try {
      // Round-trip through the parser so a hand-edited log is caught too.
      const document = parseWitness(JSON.stringify(record.witness.document));
      replayed = classifyWitness(document, record.witness.exitCode);
    } catch (error) {
      replayed = {
        outcome: "tool_error",
        verified: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  } else {
    replayed = { outcome: "tool_error", verified: false, reason: stored.reason };
  }
  // Re-derive each case from what `tsr run` printed; never trust the stored flag.
  const caseMismatch = record.cases.find(
    (c) => c.passed !== (c.actual !== null && c.actual === c.expect.trim()),
  );
  const passed =
    replayed.outcome === "pass" &&
    replayed.verified &&
    record.cases.every((c) => c.actual !== null && c.actual === c.expect.trim());
  return {
    file: record.file,
    storedOutcome: stored.outcome,
    replayedOutcome: replayed.outcome,
    resultId: record.witness.document?.result_id,
    passed,
    consistent:
      stored.outcome === replayed.outcome &&
      stored.verified === replayed.verified &&
      caseMismatch === undefined,
    reason:
      replayed.reason ??
      (caseMismatch
        ? `case ${caseMismatch.function}(${caseMismatch.args.join(",")}) stored passed=${caseMismatch.passed} but printed ${JSON.stringify(caseMismatch.actual)}, expected ${JSON.stringify(caseMismatch.expect)}`
        : undefined),
  };
}

function collectRecords(value: unknown, out: TesseraVerificationRecord[]): void {
  if (isVerificationRecord(value)) {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) for (const item of value) collectRecords(item, out);
  else if (isObject(value)) for (const item of Object.values(value)) collectRecords(item, out);
}

/** Every Tessera verification stored in a Lattice run log (`.lattice/runs/<id>.jsonl`), replayed. */
export async function replayRunLog(path: string): Promise<ReplayedVerification[]> {
  const records: TesseraVerificationRecord[] = [];
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as { type?: string; payload?: unknown };
    if (event.type === "tool.completed") collectRecords(event.payload, records);
  }
  return records.map(replayVerification);
}
