// SEARCH/REPLACE edits as repair candidates.
//
// Whole-file candidates make the model re-emit every line it does not change,
// and a long file invites drift in the untouched parts. Roo Code (`apply_diff`),
// Cline (`replace_in_file`) and Kilo Code (`edit`) instead take blocks of
// "this text becomes that text", matched exactly first and then with
// progressively looser comparisons, refuse ambiguous matches, and answer a
// failed match with the closest region of the file so the next attempt is
// grounded in what is really there. This module applies the same ideas to
// `tsr` repair candidates; the code is our own.

export const SEARCH_MARKER = "<<<<<<< SEARCH";
export const DIVIDER_MARKER = "=======";
export const REPLACE_MARKER = ">>>>>>> REPLACE";

export interface SearchReplaceBlock {
  search: string;
  replace: string;
}

/** How a block was located in the file. */
export type MatchStrategy = "exact" | "line-trimmed" | "whitespace-insensitive";

export interface AppliedBlock {
  strategy: MatchStrategy;
  /** 1-based first line of the replaced region in the file before this block. */
  line: number;
}

export type EditResult =
  | { ok: true; source: string; applied: AppliedBlock[] }
  | { ok: false; error: string };

/** Whether a candidate action is written as SEARCH/REPLACE blocks. */
export function isSearchReplace(action: string): boolean {
  return action.split(/\r?\n/).some((line) => line.trim() === SEARCH_MARKER);
}

/** The blocks of an action, or an error naming what is malformed. */
export function parseSearchReplace(action: string): SearchReplaceBlock[] | string {
  const lines = action.replace(/\r\n/g, "\n").split("\n");
  const blocks: SearchReplaceBlock[] = [];
  let state: "outside" | "search" | "replace" = "outside";
  let search: string[] = [];
  let replace: string[] = [];
  for (const line of lines) {
    const marker = line.trim();
    if (state === "outside") {
      if (marker === SEARCH_MARKER) {
        state = "search";
        search = [];
      } else if (marker === DIVIDER_MARKER || marker === REPLACE_MARKER) {
        return `block ${blocks.length + 1}: ${marker} before ${SEARCH_MARKER}`;
      }
    } else if (state === "search") {
      if (marker === DIVIDER_MARKER) {
        state = "replace";
        replace = [];
      } else if (marker === SEARCH_MARKER || marker === REPLACE_MARKER) {
        return `block ${blocks.length + 1}: expected ${DIVIDER_MARKER} after the SEARCH text, found ${marker}`;
      } else search.push(line);
    } else if (marker === REPLACE_MARKER) {
      blocks.push({ search: search.join("\n"), replace: replace.join("\n") });
      state = "outside";
    } else if (marker === SEARCH_MARKER || marker === DIVIDER_MARKER) {
      return `block ${blocks.length + 1}: expected ${REPLACE_MARKER} after the REPLACE text, found ${marker}`;
    } else replace.push(line);
  }
  if (state !== "outside") return `block ${blocks.length + 1}: missing ${REPLACE_MARKER}`;
  if (!blocks.length) return "no SEARCH/REPLACE blocks";
  const empty = blocks.findIndex((b) => !b.search.trim());
  if (empty !== -1) return `block ${empty + 1}: SEARCH text is empty; quote the lines to change`;
  return blocks;
}

interface Span {
  start: number;
  end: number;
}

function occurrences(haystack: string, needle: string): Span[] {
  const out: Span[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    out.push({ start: i, end: i + needle.length });
  }
  return out;
}

/** Character offset at which each line starts, plus the end of the text. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/** Windows of whole lines whose trimmed text equals the search's trimmed lines. */
function lineTrimmedMatches(content: string, search: string): Span[] {
  const lines = content.split("\n");
  const starts = lineStarts(content);
  const want = search.split("\n").map((l) => l.trim());
  while (want.length && want[want.length - 1] === "") want.pop();
  if (!want.length) return [];
  const out: Span[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((w, j) => lines[i + j]!.trim() === w)) {
      const last = i + want.length - 1;
      out.push({ start: starts[i]!, end: starts[last]! + lines[last]!.length });
    }
  }
  return out;
}

/**
 * Matches with all whitespace ignored on both sides, mapped back to the
 * original text. `a + b` matches `a+b`; the replaced span starts and ends on
 * non-whitespace characters.
 */
function whitespaceInsensitiveMatches(content: string, search: string): Span[] {
  const index: number[] = [];
  let squeezed = "";
  for (let i = 0; i < content.length; i++) {
    if (!/\s/.test(content[i]!)) {
      squeezed += content[i];
      index.push(i);
    }
  }
  const needle = search.replace(/\s+/g, "");
  if (!needle) return [];
  return occurrences(squeezed, needle).map((m) => ({
    start: index[m.start]!,
    end: index[m.end - 1]! + 1,
  }));
}

const STRATEGIES: Array<[MatchStrategy, (content: string, search: string) => Span[]]> = [
  ["exact", occurrences],
  ["line-trimmed", lineTrimmedMatches],
  ["whitespace-insensitive", whitespaceInsensitiveMatches],
];

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

/** 1 for identical text, 0 for nothing in common. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - editDistance(a, b) / longest;
}

/** The window of lines most like `search`, for a failed match's feedback. */
export function closestRegion(
  content: string,
  search: string,
): { line: number; text: string; similarity: number } | undefined {
  const lines = content.split("\n");
  const height = Math.max(1, search.split("\n").length);
  let best: { line: number; text: string; similarity: number } | undefined;
  for (let i = 0; i + height <= Math.max(lines.length, height); i++) {
    const text = lines.slice(i, i + height).join("\n");
    const score = similarity(text.trim(), search.trim());
    if (!best || score > best.similarity) best = { line: i + 1, text, similarity: score };
  }
  return best;
}

function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (content[i] === "\n") line++;
  return line;
}

/**
 * Applies blocks in order, each to the result of the previous one. A block
 * must match exactly one place under the first strategy that matches at all;
 * none or several is an error that says what to send instead.
 */
export function applySearchReplace(content: string, blocks: SearchReplaceBlock[]): EditResult {
  let source = content;
  const applied: AppliedBlock[] = [];
  for (const [n, block] of blocks.entries()) {
    let done = false;
    for (const [strategy, find] of STRATEGIES) {
      const matches = find(source, block.search);
      if (!matches.length) continue;
      if (matches.length > 1) {
        const at = matches.map((m) => lineOf(source, m.start)).join(", ");
        return {
          ok: false,
          error: `SEARCH block ${n + 1} matches ${matches.length} places (lines ${at}); include more surrounding text so it matches one`,
        };
      }
      const [match] = matches as [Span];
      applied.push({ strategy, line: lineOf(source, match.start) });
      source = source.slice(0, match.start) + block.replace + source.slice(match.end);
      done = true;
      break;
    }
    if (!done) {
      const near = closestRegion(source, block.search);
      return {
        ok: false,
        error: [
          `SEARCH block ${n + 1} does not match the current file.`,
          ...(near && near.similarity > 0
            ? [
                `Closest text (line ${near.line}, ${Math.round(near.similarity * 100)}% similar):`,
                near.text,
              ]
            : []),
          "Copy the SEARCH text from the current file exactly, or send the complete file instead.",
        ].join("\n"),
      };
    }
  }
  return { ok: true, source, applied };
}

/** Applies an action written as SEARCH/REPLACE blocks to `content`. */
export function applyEditAction(content: string, action: string): EditResult {
  const blocks = parseSearchReplace(action);
  if (typeof blocks === "string") return { ok: false, error: `malformed SEARCH/REPLACE edit: ${blocks}` };
  return applySearchReplace(content, blocks);
}
