import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { delimiter, join, resolve, sep } from "node:path";
import { runCommand, CommandResult, CommandSpec } from "./index.js";

/**
 * Agent Skills manifest (a subset of the Agent Skills `SKILL.md` front-matter
 * contract). Only metadata is trusted: the `instructions`, `references` and
 * `scripts` tiers stay unread until a planner selects them.
 */
export interface SkillManifest {
  name: string;
  description: string;
  version?: string;
  license?: string;
  /** Tool names the skill asks for, e.g. `Bash(git:*)`. Never granted implicitly. */
  allowedTools: string[];
  /** Bundled reference files (relative to the manifest directory). */
  references: string[];
  /** Bundled scripts (relative). Indexed, never executed by Lattice. */
  scripts: string[];
  /** Bundled assets (relative). */
  assets: string[];
  /** Raw front-matter without the instruction body, for provenance. */
  frontmatter: string;
  /** sha256 of the whole `SKILL.md`. */
  sha256: string;
  /** Absolute path of the `SKILL.md`. */
  path: string;
}

export type SkillTrustTier = "project" | "user" | "external";

export interface SkillEntry {
  manifest: SkillManifest;
  /** Where the manifest came from; `external` is never auto-trusted. */
  tier: SkillTrustTier;
  /** Human-readable provenance, e.g. `.claude/skills/debugging/SKILL.md`. */
  origin: string;
}

export interface SkillIndexOptions {
  cwd: string;
  /** Extra roots (e.g. an installed skills library), highest precedence last. */
  roots?: string[];
  /** Include `~/.claude/skills` and `~/.agents/skills`. Default true. */
  includeUserSkills?: boolean;
  /** Max manifests to read. Default 400. */
  limit?: number;
  /** Injectable environment, for tests and hermetic runs. */
  env?: NodeJS.ProcessEnv;
}

export interface SkillIndex {
  cwd: string;
  skills: SkillEntry[];
  /** Roots that were scanned, for auditability. */
  scanned: string[];
  /** Manifests that failed validation; never silently dropped. */
  rejected: Array<{ path: string; reason: string }>;
}

const MANIFEST_NAMES = ["SKILL.md"] as const;

const MAX_MANIFEST_BYTES = 256 * 1024;

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Characters that must never appear in a skill name (path traversal, YAML smuggling). */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

interface Frontmatter {
  name?: string;
  description?: string;
  version?: string;
  license?: string;
  allowedTools: string[];
  references: string[];
  scripts: string[];
  assets: string[];
}

/**
 * Parse the YAML subset used by Agent Skills manifests. Deliberately not a full
 * YAML implementation: only flat scalars and `- item` lists are supported, and
 * anything else is rejected so a hostile manifest cannot smuggle structure.
 */
export function parseSkillFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) {
    throw new Error("SKILL.md must start with a YAML front-matter block delimited by ---");
  }
  const frontmatterRaw = match[1]!;
  const body = match[2] ?? "";
  const frontmatter: Frontmatter = { allowedTools: [], references: [], scripts: [], assets: [] };
  const listTargets = new Map<RegExp, keyof Frontmatter>();
  const scalars = new Map<string, string>();

  let activeKey: string | undefined;
  for (const line of frontmatterRaw.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const listItem = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (listItem && activeKey) {
      const value = stripQuotes(listItem[1]!);
      const buckets: Record<string, string[]> = {
        "allowed-tools": frontmatter.allowedTools,
        allowedTools: frontmatter.allowedTools,
        references: frontmatter.references,
        scripts: frontmatter.scripts,
        assets: frontmatter.assets,
      };
      buckets[activeKey]?.push(value);
      continue;
    }

    const entry = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!entry) {
      throw new Error(`unsupported SKILL.md front-matter line: ${line.trim().slice(0, 60)}`);
    }
    const key = entry[1]!;
    const value = entry[2] ?? "";
    activeKey = value.trim() ? undefined : key;
    if (!value.trim()) {
      if (!["allowed-tools", "allowedTools", "references", "scripts", "assets"].includes(key)) {
        throw new Error(`unsupported SKILL.md list key: ${key}`);
      }
      continue;
    }
    scalars.set(key, stripQuotes(value.trim()));
  }

  frontmatter.name = scalars.get("name");
  frontmatter.description = scalars.get("description");
  frontmatter.version = scalars.get("version");
  frontmatter.license = scalars.get("license");

  if (!frontmatter.name || !NAME_PATTERN.test(frontmatter.name)) {
    throw new Error(`invalid or missing skill name (expected lowercase-kebab): ${frontmatter.name ?? "<none>"}`);
  }
  if (!frontmatter.description || frontmatter.description.length < 8) {
    throw new Error("SKILL.md must provide a description of at least 8 characters");
  }

  return { frontmatter, body };
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** Relative-path guard shared by manifest parsing and disclosure loading. */
export function safeRelativePath(input: string): string | undefined {
  if (typeof input !== "string" || !input.trim()) return undefined;
  if (input.includes("\0")) return undefined;
  const segments = input.split(/[\\/]+/).filter(Boolean);
  if (!segments.length) return undefined;
  for (const segment of segments) {
    if (segment === ".." || segment === "." || !SAFE_SEGMENT.test(segment)) return undefined;
  }
  return segments.join(sep);
}

export interface ParsedSkillFile {
  manifest: SkillManifest;
  /** Instruction tier; only materialized when the skill is selected. */
  instructions: string;
}

export async function parseSkillFile(path: string): Promise<ParsedSkillFile> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) {
    throw new Error("SKILL.md must be a regular file of at most 256 KiB");
  }
  const raw = await readFile(path, "utf8");
  const { frontmatter, body } = parseSkillFrontmatter(raw);
  const manifest: SkillManifest = {
    name: frontmatter.name!,
    description: frontmatter.description!,
    version: frontmatter.version,
    license: frontmatter.license,
    allowedTools: frontmatter.allowedTools,
    references: frontmatter.references.map(safeRelativePath).filter(Boolean) as string[],
    scripts: frontmatter.scripts.map(safeRelativePath).filter(Boolean) as string[],
    assets: frontmatter.assets.map(safeRelativePath).filter(Boolean) as string[],
    frontmatter: raw,
    sha256: createHash("sha256").update(raw).digest("hex"),
    path: resolve(path),
  };
  return { manifest, instructions: body.trim() };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function listDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

function homeOf(env: NodeJS.ProcessEnv): string | undefined {
  return env.HOME ?? env.USERPROFILE ?? undefined;
}

/**
 * Index `SKILL.md` manifests by progressive discovery. Manifest metadata is read;
 * instruction bodies, references and scripts are never loaded here.
 */
export async function indexSkills(options: SkillIndexOptions): Promise<SkillIndex> {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd);
  const limit = options.limit ?? 400;
  const roots: Array<{ path: string; tier: SkillTrustTier }> = [];

  for (const extra of options.roots ?? []) roots.push({ path: resolve(cwd, extra), tier: "external" });
  for (const relative of [".claude/skills", ".agents/skills", ".cursor/skills", ".opencode/skills"]) {
    const candidate = resolve(cwd, relative);
    if (await isDirectory(candidate)) roots.push({ path: candidate, tier: "project" });
  }

  if (options.includeUserSkills !== false) {
    const home = homeOf(env);
    if (home) {
      for (const relative of [".claude/skills", ".agents/skills"]) {
        const candidate = resolve(home, relative);
        if (await isDirectory(candidate)) roots.push({ path: candidate, tier: "user" });
      }
    }
  }

  const index: SkillIndex = { cwd, skills: [], scanned: roots.map((root) => root.path), rejected: [] };
  const seen = new Set<string>();

  for (const root of roots) {
    for (const skillDir of await listDirectories(root.path)) {
      for (const manifestName of MANIFEST_NAMES) {
        const manifestPath = join(root.path, skillDir, manifestName);
        const info = await stat(manifestPath).catch(() => undefined);
        if (!info?.isFile()) continue;
        if (index.skills.length >= limit) return index;
        try {
          const parsed = await parseSkillFile(manifestPath);
          if (seen.has(parsed.manifest.name)) break;
          seen.add(parsed.manifest.name);
          index.skills.push({
            manifest: parsed.manifest,
            tier: root.tier,
            origin: manifestPath.split(sep).slice(-3).join(sep),
          });
        } catch (error) {
          index.rejected.push({
            path: manifestPath.split(sep).slice(-3).join(sep),
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }
    }
  }

  return index;
}

// ---------------------------------------------------------------------------
// Tool viability probes (GRETEL-style: a tool that exists is not a tool that works)

export interface ProbeSpec {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  /** Env vars that must be non-empty for the probe to be meaningful. */
  requiresEnv?: string[];
  /** When true, a non-zero exit is treated as viable-but-unhealthy. */
  tolerateExitCode?: boolean;
}

export interface ProbeResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Diagnostics for the ledger; never the full unbounded output. */
  note: string;
}

/**
 * Non-mutating viability probe for an external capability. Never performs a
 * mutating call, and records *why* a tool is unavailable instead of hiding it.
 */
export async function probeExecutable(
  spec: ProbeSpec,
  run: (command: CommandSpec) => Promise<CommandResult> = runCommand,
): Promise<ProbeResult> {
  const missing = (spec.requiresEnv ?? []).filter((name) => !process.env[name]?.trim());
  try {
    const result = await run({
      command: spec.command,
      args: spec.args ?? [],
      cwd: spec.cwd,
      timeoutMs: spec.timeoutMs ?? 3_000,
      maxOutputBytes: 8_000,
    });
    const ok = result.timedOut
      ? false
      : result.exitCode === 0 || (spec.tolerateExitCode ?? false);
    const note = missing.length
      ? `missing credentials: ${missing.join(", ")}`
      : result.exitCode === 0
        ? "probe succeeded"
        : `probe exited ${result.exitCode ?? "null"}`;
    return {
      ok: ok && missing.length === 0,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdout.slice(0, 8_000),
      stderr: result.stderr.slice(0, 8_000),
      note,
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      note: missing.length
        ? `missing credentials: ${missing.join(", ")}; spawn failed`
        : `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Resolve a command across PATH, honouring PATHEXT on Windows. */
export async function findExecutable(
  command: string,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const raw = String(env.PATH ?? "");
  const pathext = (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean);
  const dirs = raw.split(delimiter).filter(Boolean);
  const hasExtension = /\.[A-Za-z0-9]+$/.test(command);
  const candidates = hasExtension
    ? [command]
    : process.platform === "win32"
      ? [command, ...pathext.map((ext) => `${command}${ext}`)]
      : [command];

  for (const candidate of candidates) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      const absolute = resolve(cwd, candidate);
      if (await isExecutableFile(absolute)) return absolute;
      continue;
    }
    for (const dir of dirs) {
      const absolute = resolve(dir, candidate);
      if (await isExecutableFile(absolute)) return absolute;
    }
  }
  return undefined;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// MCP tool schema validation (metadata only; no transport here)

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpToolsListPage {
  tools?: McpTool[];
  nextCursor?: string | null;
}

export type SchemaValidation =
  | { ok: true }
  | { ok: false; problem: string };

/** Structural validation of a discovered MCP tool's JSON Schema metadata. */
export function validateMcpTool(tool: McpTool): SchemaValidation {
  if (!tool || typeof tool.name !== "string" || !tool.name.trim()) {
    return { ok: false, problem: "tool name is missing" };
  }
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) {
    return { ok: false, problem: `tool name has unsupported characters: ${tool.name}` };
  }
  if (tool.description !== undefined && typeof tool.description !== "string") {
    return { ok: false, problem: "tool description must be a string" };
  }
  const schema = tool.inputSchema;
  if (schema !== undefined) {
    if (typeof schema !== "object" || Array.isArray(schema) || schema === null) {
      return { ok: false, problem: "inputSchema must be a JSON object" };
    }
    if (schema.type !== undefined && schema.type !== "object") {
      return { ok: false, problem: "inputSchema.type must be 'object'" };
    }
  }
  return { ok: true };
}

/**
 * Merge a paginated `tools/list` response. Cursor handling is explicit so a
 * truncated page cannot silently look like a complete registry.
 */
export function mergeMcpToolPages(
  pages: McpToolsListPage[],
): { tools: McpTool[]; complete: boolean; cursors: (string | null)[] } {
  const tools: McpTool[] = [];
  const cursors: (string | null)[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    for (const tool of page.tools ?? []) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      tools.push(tool);
    }
    cursors.push(page.nextCursor ?? null);
  }
  const complete = cursors.length > 0 && cursors[cursors.length - 1] == null;
  return { tools, complete, cursors };
}

/** Write a findings artifact next to the run directory for post-hoc review. */
export async function writeFindings(
  directory: string,
  filename: string,
  contents: string,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, filename);
  await writeFile(path, contents, "utf8");
  return path;
}
