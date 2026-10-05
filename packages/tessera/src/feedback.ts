// What the repair model is shown about `tsr`'s verdicts, and the repairs `tsr`
// itself suggests.
//
// Self-repair is bounded by feedback quality (Olausson et al., ICLR 2024) and
// works best when each attempt is paired with the error it produced (Chen et
// al., "Self-Debug", ICLR 2024); concise tool output beats verbose output for
// agents (Yang et al., SWE-agent, 2024). So diagnostics are rendered like a
// compiler prints them (source line, caret, help) and capped, and every
// rejected attempt carries its own feedback. Sources and rationale:
// sp80808/Tessera docs/research/2026-10-04-llm-repair.md.
import { createHash } from "node:crypto";
import { runCommand } from "@lattice/execution";
import type {
  GeneratorProvider,
  GeneratorRequest,
  GeneratorResult,
} from "@lattice/protocol";
import {
  resolveTsr,
  type TesseraVerificationRecord,
  type WitnessDiagnostic,
  type WitnessDocument,
} from "./witness.js";

/** A whole-file repair `tsr witness` offers; it passed `tsr check`, nothing more. */
export interface WitnessSuggestion {
  source: string;
  label: string;
}

/** `suggestions` of a witness document (absent before Tessera added them). */
export function witnessSuggestions(document: WitnessDocument | undefined): WitnessSuggestion[] {
  const raw = document?.suggestions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((s) =>
    s && typeof s.source === "string" && s.source.trim()
      ? [{ source: s.source, label: typeof s.label === "string" ? s.label : "tsr suggestion" }]
      : [],
  );
}

function help(d: WitnessDiagnostic): string | undefined {
  const value = (d as { help?: unknown }).help;
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Diagnostics as a compiler prints them: code, position, message, the source
 * line with a caret under the span, and `help`. At most `max` are shown; the
 * rest are usually parser cascades and only counted.
 */
export function renderDiagnostics(
  source: string,
  diagnostics: WitnessDiagnostic[],
  max = 3,
): string {
  const lines = source.split("\n");
  const out: string[] = [];
  for (const d of diagnostics.slice(0, max)) {
    const at = d.line != null && d.col != null ? `${d.line}:${d.col}` : "-";
    out.push(`${d.severity}[${d.code}] ${at}: ${d.message}`);
    const text = d.line != null ? lines[d.line - 1] : undefined;
    if (text !== undefined && d.col != null && d.span) {
      const width = Math.max(1, Math.min(d.span.end - d.span.start, text.length - d.col + 1));
      out.push(`  | ${text}`, `  | ${" ".repeat(Math.max(0, d.col - 1))}${"^".repeat(width)}`);
    }
    const h = help(d);
    if (h) out.push(`  help: ${h}`);
  }
  if (diagnostics.length > max) out.push(`(${diagnostics.length - max} more, likely follow-on errors)`);
  return out.join("\n");
}

/** What `tsr` said about one verification, for the model. */
export function renderVerdict(source: string, record: TesseraVerificationRecord): string {
  const { verdict, document } = record.witness;
  if (verdict.outcome === "fail" && document) {
    return renderDiagnostics(source, document.diagnostics);
  }
  if (verdict.outcome !== "pass") {
    return `tsr witness: ${verdict.outcome}${verdict.reason ? ` (${verdict.reason})` : ""}`;
  }
  const failed = record.cases.filter((c) => !c.passed);
  if (!failed.length) return "tsr witness: pass; every case matches";
  return [
    "compiles, but behaviour is wrong:",
    ...failed.map((c) => {
      const call = `${c.function}(${c.args.join(", ")})`;
      return c.actual === null
        ? `  ${call} did not return${c.stderr ? `: ${c.stderr.slice(0, 160)}` : ""}`
        : `  ${call} returned ${c.actual}, expected ${c.expect}`;
    }),
  ].join("\n");
}

export interface Attempt {
  source: string;
  record: TesseraVerificationRecord;
}

export const ATTEMPTS_HEADER = "REJECTED ATTEMPTS AND WHAT TSR SAID (most recent last):";

/** The last `max` rejected attempts, each with its own feedback. */
export function renderAttempts(attempts: Attempt[], max = 3): string | undefined {
  if (!attempts.length) return undefined;
  const shown = attempts.slice(-max);
  return [
    ATTEMPTS_HEADER,
    ...(attempts.length > shown.length ? [`(${attempts.length - shown.length} earlier attempts omitted)`] : []),
    ...shown.map(
      (a, i) => `--- attempt ${attempts.length - shown.length + i + 1}:\n${a.source.trim()}\n>>> ${renderVerdict(a.source, a.record).replace(/\n/g, "\n    ")}`,
    ),
  ].join("\n");
}

const grammars = new Map<string, Promise<string | undefined>>();

/**
 * `tsr grammar` (EBNF) for the prompt: models given a DSL's grammar write it
 * more reliably (Wang et al., "Grammar Prompting", NeurIPS 2023). Undefined
 * when this `tsr` predates the command. Cached per executable.
 */
export function loadGrammar(tsr?: string): Promise<string | undefined> {
  const command = resolveTsr(tsr);
  let cached = grammars.get(command);
  if (!cached) {
    cached = runCommand({ command, args: ["grammar"], timeoutMs: 30_000 })
      .then((r) => (r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : undefined))
      .catch(() => undefined);
    grammars.set(command, cached);
  }
  return cached;
}

function zeroUsage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, latencyMs: 0 };
}

/** Candidate id prefix for repairs `tsr` suggested. */
export const SUGGESTION_ID_PREFIX = "tsr-";

/**
 * Offers `tsr`'s own checked suggestions before asking the model, so a repair
 * the compiler can already spell costs no tokens (a deterministic
 * parent-language repair, cf. SPEAC, NeurIPS 2024). A suggestion stays
 * pending until it is verified, offered at most `maxOffers` times (the
 * decider may pick another candidate of the round); when none are pending
 * the inner generator is called as usual.
 * Suggestions still go through the executor: only `tsr` and the cases decide.
 */
export class SuggestionFirstGenerator implements GeneratorProvider {
  private readonly offers = new Map<string, number>();

  constructor(
    private readonly inner: GeneratorProvider,
    /** Suggestions seen so far, in order. */
    private readonly pool: () => WitnessSuggestion[],
    /** Sources already verified and rejected. */
    private readonly tried: () => string[],
    private readonly maxOffers = 2,
  ) {}

  async generate(request: GeneratorRequest): Promise<GeneratorResult> {
    const count = Number(/up to (\d+)/.exec(request.prompt)?.[1] ?? 4);
    const tried = new Set(this.tried().map((s) => s.trim()));
    const pending = this.pool().filter(
      (s) => !tried.has(s.source.trim()) && (this.offers.get(s.source.trim()) ?? 0) < this.maxOffers,
    );
    if (!pending.length) return this.inner.generate(request);
    const batch = pending.slice(0, count);
    for (const s of batch) this.offers.set(s.source.trim(), (this.offers.get(s.source.trim()) ?? 0) + 1);
    const candidates = batch.map((s) => ({
      id: `${SUGGESTION_ID_PREFIX}${createHash("sha256").update(s.source).digest("hex").slice(0, 8)}`,
      label: `tsr suggestion: ${s.label}`,
      action: s.source,
      expectedEvidence: "tsr witness pass and every run case matches",
      estimatedCost: "low",
    }));
    return {
      text: JSON.stringify({ candidates }),
      identity: { provider: "tsr", model: "witness-suggestions" },
      usage: zeroUsage(),
    };
  }
}
