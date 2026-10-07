// Repair memory: verified failure → fix pairs from earlier runs, retrieved by
// how similar their failure is to the current one and shown to the generator
// as worked examples. This is the "failure/fix memory" of
// docs/self-improvement.md (L2) put to use: only pairs `tsr` verified are
// stored, so the memory never teaches a fix that did not pass.
//
// Retrieval is lexical on purpose (diagnostic codes, then words of what `tsr`
// said), the cheap end of retrieval-augmented repair: RAP-Gen (Wang et al.,
// 2023) retrieves fix pairs this way before generating. A run never retrieves
// its own task, so seeds of one task cannot teach each other and a held-out
// task sees only other tasks' fixes.
import { appendFile, readFile } from "node:fs/promises";
import { renderVerdict } from "./feedback.js";
import type { TesseraVerificationRecord } from "./witness.js";

export const MEMORY_SCHEMA = "lattice.tessera-repair-memory/v0";

export interface RepairMemoryEntry {
  schema: typeof MEMORY_SCHEMA;
  /** Task the pair came from; never retrieved for the same task. */
  task: string;
  before: string;
  after: string;
  /** Diagnostic codes `tsr` reported on `before`; `behaviour` when it compiled but cases failed. */
  codes: string[];
  /** What `tsr` said about `before`, as the generator was shown it. */
  failure: string;
  /** Witness `result_id` of `before`, so the pair can be traced to a run. */
  resultId?: string;
  tsr?: { version: string; commit: string };
  at: string;
}

/** Codes that identify a failure: diagnostic codes, or `behaviour` for wrong results. */
export function failureCodes(record: TesseraVerificationRecord): string[] {
  const diagnostics = record.witness.document?.diagnostics ?? [];
  const codes = diagnostics.map((d) => d.code);
  if (!codes.length && record.cases.some((c) => !c.passed)) codes.push("behaviour");
  return [...new Set(codes)];
}

export function memoryEntry(
  task: string,
  before: string,
  after: string,
  record: TesseraVerificationRecord,
): RepairMemoryEntry {
  const tool = record.witness.document?.tool;
  return {
    schema: MEMORY_SCHEMA,
    task,
    before,
    after,
    codes: failureCodes(record),
    failure: renderVerdict(before, record),
    resultId: record.witness.document?.result_id,
    ...(tool ? { tsr: { version: tool.version, commit: tool.commit } } : {}),
    at: new Date().toISOString(),
  };
}

/** Entries of a JSONL memory file; a missing file is an empty memory. */
export async function loadRepairMemory(path: string): Promise<RepairMemoryEntry[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line, i) => {
      const entry = JSON.parse(line) as RepairMemoryEntry;
      if (entry.schema !== MEMORY_SCHEMA || typeof entry.before !== "string" || typeof entry.after !== "string") {
        throw new Error(`${path}:${i + 1}: not a ${MEMORY_SCHEMA} entry`);
      }
      return entry;
    });
}

export async function appendRepairMemory(path: string, entries: RepairMemoryEntry[]): Promise<void> {
  if (entries.length) await appendFile(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

const words = (text: string) => new Set(text.toLowerCase().match(/[a-z_][a-z0-9_-]{2,}/g) ?? []);

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

export interface RetrievedRepair {
  entry: RepairMemoryEntry;
  score: number;
}

/**
 * The `k` entries whose failure is most like `record`'s: shared diagnostic
 * codes count most, then shared words of what `tsr` said. Entries of `task`,
 * entries for the same broken program, and entries sharing no code are left out.
 */
export function retrieveRepairs(
  memory: RepairMemoryEntry[],
  task: string,
  source: string,
  record: TesseraVerificationRecord,
  k = 2,
): RetrievedRepair[] {
  const codes = new Set(failureCodes(record));
  const said = words(renderVerdict(source, record));
  const seen = new Set<string>();
  return memory
    .filter((entry) => entry.task !== task && entry.before.trim() !== source.trim())
    // A shared code is required: an unrelated failure's fix is a misleading example.
    .filter((entry) => entry.codes.some((code) => codes.has(code)))
    .map((entry) => ({
      entry,
      score: 2 * jaccard(codes, new Set(entry.codes)) + jaccard(said, words(entry.failure)),
    }))
    .sort((a, b) => b.score - a.score)
    .filter((r) => {
      // One example per distinct fix.
      const key = `${r.entry.before.trim()}\0${r.entry.after.trim()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, k);
}

export const MEMORY_HEADER =
  "PAST VERIFIED REPAIRS OF SIMILAR FAILURES (other programs, each fix passed tsr; examples, not this file):";

export function renderRepairs(found: RetrievedRepair[]): string | undefined {
  if (!found.length) return undefined;
  return [
    MEMORY_HEADER,
    ...found.map(
      ({ entry }) =>
        `--- broken:\n${entry.before.trim()}\n>>> ${entry.failure.replace(/\n/g, "\n    ")}\n--- fixed:\n${entry.after.trim()}`,
    ),
  ].join("\n");
}
