import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { collectRepositorySnapshot, digest, type RepositorySnapshot } from "./index.js";

/** Task classes the planner discriminates between. Deliberately small and lexical. */
export type TaskClass =
  | "bugfix"
  | "debug"
  | "feature"
  | "ui"
  | "refactor"
  | "performance"
  | "upgrade"
  | "security"
  | "docs"
  | "test"
  | "research"
  | "unknown";

export type StackTag =
  | "typescript"
  | "javascript"
  | "react"
  | "next"
  | "vite"
  | "node"
  | "rust"
  | "python"
  | "go"
  | "java"
  | "ruby"
  | "php"
  | "c"
  | "cpp"
  | "zig"
  | "swift"
  | "kotlin"
  | "wasm"
  | "web"
  | "mobile"
  | "cli"
  | "library"
  | "compiler"
  | "database"
  | "sqlite"
  | "ml"
  | "tessera";

export interface ManifestFact {
  /** Path relative to the repository root, e.g. `package.json`. */
  path: string;
  /** Manifest kind, used for deterministic toolchain inference. */
  kind:
    | "node-package"
    | "node-workspace"
    | "node-lock"
    | "tsconfig"
    | "cargo"
    | "cargo-lock"
    | "python-project"
    | "python-requirements"
    | "go-mod"
    | "maven"
    | "gradle"
    | "gemfile"
    | "composer"
    | "tessera"
    | "makefile"
    | "ci";
  /** sha256 of the manifest contents; identifies the inspected fact, not the repo. */
  sha256: string;
  /** Bounded excerpt of the interesting fields, never the raw file. */
  summary: string;
}

export interface ProjectFingerprint {
  root: string;
  revision?: string;
  dirty?: boolean;
  /** sha256 over the manifest facts, so two repos with the same stack hash alike. */
  fingerprintSha: string;
  languages: string[];
  stacks: StackTag[];
  manifests: ManifestFact[];
  frameworks: string[];
  dependencies: string[];
  devDependencies: string[];
  packageManagers: string[];
  testCommands: string[];
  buildCommands: string[];
  ci: string[];
  appType: "web-app" | "pwa" | "cli" | "library" | "compiler" | "service" | "mobile" | "unknown";
  platforms: string[];
  tractFiles: number;
  source: "git" | "filesystem";
  /** Facts a planner may rely on; anything absent is `unknown`, never guessed. */
  uncertainties: string[];
}

interface PackageJsonShape {
  name?: unknown;
  packageManager?: unknown;
  workspaces?: unknown;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  scripts?: Record<string, unknown>;
}

const MAX_SUMMARY_CHARS = 600;

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_SUMMARY_CHARS
    ? `${collapsed.slice(0, MAX_SUMMARY_CHARS - 1)}…`
    : collapsed;
}

async function readTextFile(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return undefined;
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function listFiles(root: string, relative: string): Promise<string[]> {
  try {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

/** Deterministic, dependency-free JSON parse. Returns undefined for anything else. */
function parseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const NODE_STACK_BY_DEP: Record<string, StackTag> = {
  react: "react",
  "react-dom": "react",
  next: "next",
  vite: "vite",
  "@tanstack/react-start": "web",
  express: "node",
  fastify: "node",
  hono: "node",
  typescript: "typescript",
  prisma: "database",
  drizzle: "database",
  "typeorm": "database",
  pg: "database",
  sqlite3: "sqlite",
  "better-sqlite3": "sqlite",
  zod: "typescript",
  tailwindcss: "web",
};

const PYTHON_STACK_BY_DEP: Record<string, StackTag> = {
  numpy: "ml",
  pandas: "ml",
  torch: "ml",
  tensorflow: "ml",
  django: "web",
  flask: "web",
  fastapi: "web",
  sqlalchemy: "database",
};

const FRAMEWORK_BY_PACKAGE: Record<string, string> = {
  react: "React",
  "react-dom": "React",
  next: "Next.js",
  vite: "Vite",
  vue: "Vue",
  svelte: "Svelte",
  "@angular/core": "Angular",
  express: "Express",
  fastify: "Fastify",
  hono: "Hono",
  tailwindcss: "Tailwind CSS",
  ink: "Ink",
  typescript: "TypeScript",
  jest: "Jest",
  vitest: "Vitest",
};

const TESSERA_STACK: StackTag[] = ["compiler", "library", "tessera"];

function pushUnique(target: string[], value: string | undefined): void {
  if (value && !target.includes(value)) target.push(value);
}

function pushAll(target: StackTag[], values: Array<StackTag | undefined>): void {
  for (const value of values) if (value && !target.includes(value)) target.push(value);
}

/**
 * Deterministic project inspection. Reads manifests, lockfiles and CI files only.
 * No model is consulted, so a planner can treat every field as inspected fact and
 * must report `unknown` rather than inferring what is absent.
 */
export async function fingerprintProject(
  cwdInput: string,
  options: { maxFiles?: number; snapshot?: RepositorySnapshot } = {},
): Promise<ProjectFingerprint> {
  const root = resolve(cwdInput);
  const snapshot = options.snapshot ?? (await collectRepositorySnapshot(root, options.maxFiles ?? 2_000));

  const manifests: ManifestFact[] = [];
  const languages: string[] = [];
  const stacks: StackTag[] = [];
  const frameworks: string[] = [];
  const dependencies: string[] = [];
  const devDependencies: string[] = [];
  const packageManagers: string[] = [];
  const testCommands: string[] = [];
  const buildCommands: string[] = [];
  const ci: string[] = [];
  const uncertainties: string[] = [];

  const record = async (
    path: string,
    kind: ManifestFact["kind"],
    emptySummary: string,
  ): Promise<string | undefined> => {
    const text = await readTextFile(join(root, path));
    if (text === undefined) return undefined;
    const sha256 = digest(text);
    manifests.push({ path, kind, sha256, summary: truncate(text) || emptySummary });
    return text;
  };

  // --- Node / TypeScript -------------------------------------------------
  const packageJsonText = await record("package.json", "node-package", "{}");
  const packageJson = asRecord(parseJson(packageJsonText)) as PackageJsonShape | undefined;
  if (packageJsonText !== undefined) {
    pushUnique(languages, "javascript");
    if (packageJson === undefined) {
      uncertainties.push("package.json present but not parseable as JSON");
    }
  }

  const deps = asRecord(packageJson?.dependencies);
  const devDeps = asRecord(packageJson?.devDependencies);
  if (deps) {
    for (const [name, range] of Object.entries(deps)) {
      pushUnique(dependencies, `${name}@${typeof range === "string" ? range : "*"}`);
      pushUnique(frameworks, FRAMEWORK_BY_PACKAGE[name]);
      pushAll(stacks, [NODE_STACK_BY_DEP[name]]);
    }
  }
  if (devDeps) {
    for (const [name, range] of Object.entries(devDeps)) {
      pushUnique(devDependencies, `${name}@${typeof range === "string" ? range : "*"}`);
      pushUnique(frameworks, FRAMEWORK_BY_PACKAGE[name]);
      pushAll(stacks, [NODE_STACK_BY_DEP[name]]);
    }
  }
  if (devDeps?.typescript) pushUnique(languages, "typescript");

  const scripts = asRecord(packageJson?.scripts);
  if (scripts) {
    for (const [name, value] of Object.entries(scripts)) {
      if (typeof value !== "string") continue;
      if (/^(test|test:.*)$/.test(name)) pushUnique(testCommands, value);
      if (/^(build|compile|bundle)$/.test(name)) pushUnique(buildCommands, value);
    }
  }
  if (typeof packageJson?.packageManager === "string") {
    pushUnique(packageManagers, packageJson.packageManager.split("@")[0]!);
  }

  const packageLockText = await record("package-lock.json", "node-lock", "{}");
  if (packageLockText) pushUnique(packageManagers, "npm");
  const pnpmLockText = await record("pnpm-lock.yaml", "node-lock", "");
  if (pnpmLockText) pushUnique(packageManagers, "pnpm");
  const yarnLockText = await record("yarn.lock", "node-lock", "");
  if (yarnLockText) pushUnique(packageManagers, "yarn");

  const workspaceText = await record("pnpm-workspace.yaml", "node-workspace", "");
  if (workspaceText === undefined && Array.isArray(packageJson?.workspaces)) {
    manifests.push({
      path: "package.json",
      kind: "node-workspace",
      sha256: digest(String(packageJson?.workspaces)),
      summary: truncate(JSON.stringify(packageJson?.workspaces)),
    });
  }

  const tsconfigText = await record("tsconfig.json", "tsconfig", "{}");
  if (tsconfigText !== undefined) pushUnique(languages, "typescript");

  // --- Rust --------------------------------------------------------------
  const cargoText = await record("Cargo.toml", "cargo", "");
  if (cargoText !== undefined) {
    pushUnique(languages, "rust");
    pushAll(stacks, ["rust"]);
    const crates = [...cargoText.matchAll(/^\s*([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/gm)].map((m) => m[1]!);
    pushUnique(dependencies, crates.join(", "));
    // Only std-style crates; avoid claiming frameworks from arbitrary names.
    if (/\[workspace\]/.test(cargoText)) pushAll(stacks, ["library"]);
    if (/proc-macro\s*=\s*true/.test(cargoText)) pushAll(stacks, ["library"]);
  }
  if (await record("Cargo.lock", "cargo-lock", "")) pushUnique(packageManagers, "cargo");

  // --- Python ------------------------------------------------------------
  const pyprojectText = await record("pyproject.toml", "python-project", "");
  if (pyprojectText !== undefined) {
    pushUnique(languages, "python");
    for (const [name, tag] of Object.entries(PYTHON_STACK_BY_DEP)) {
      if (new RegExp(`["']${name.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}`, "i").test(pyprojectText)) {
        pushAll(stacks, [tag]);
      }
    }
    if (/\[tool\.poetry\]|\[project\]/.test(pyprojectText)) pushUnique(packageManagers, "pip");
  }
  if (await record("requirements.txt", "python-requirements", "")) pushUnique(packageManagers, "pip");
  if (await readTextFile(join(root, "Pipfile"))) pushUnique(packageManagers, "pipenv");
  if (await readTextFile(join(root, "poetry.lock"))) pushUnique(packageManagers, "poetry");
  if (await readTextFile(join(root, "uv.lock"))) pushUnique(packageManagers, "uv");

  // --- Go / JVM / Ruby / PHP ---------------------------------------------
  if (await record("go.mod", "go-mod", "")) {
    pushUnique(languages, "go");
    pushAll(stacks, ["go"]);
    pushUnique(packageManagers, "go");
  }
  if (await record("pom.xml", "maven", "")) {
    pushUnique(languages, "java");
    pushUnique(packageManagers, "maven");
  }
  if (await record("build.gradle", "gradle", "")) {
    pushUnique(languages, "java");
    pushUnique(packageManagers, "gradle");
  }
  if (await record("Gemfile", "gemfile", "")) {
    pushUnique(languages, "ruby");
    pushUnique(packageManagers, "bundler");
  }
  if (await record("composer.json", "composer", "")) {
    pushUnique(languages, "php");
    pushUnique(packageManagers, "composer");
  }

  // --- Tessera -----------------------------------------------------------
  const tesseraFiles = await listFiles(root, ".");
  if (tesseraFiles.some((name) => /\.(tes|tessera|tc)$/.test(name))) {
    pushUnique(languages, "tessera");
    pushAll(stacks, TESSERA_STACK);
  }
  const tesseraMakefile = await readTextFile(join(root, "Makefile"));
  if (tesseraMakefile && /tessera|tesc/.test(tesseraMakefile)) {
    pushAll(stacks, TESSERA_STACK);
    pushUnique(languages, "tessera");
    if (!buildCommands.length) pushUnique(buildCommands, "make");
  }

  if (await readTextFile(join(root, "wrangler.toml"))) pushAll(stacks, ["web"]);
  const wasmTargets = [...snapshot.trackedFiles].some((file) =>
    /(^|\/)(\.?cargo\/config\.toml|Cargo\.toml)$/.test(file),
  );
  if (wasmTargets) {
    const cargoConfig = await readTextFile(join(root, ".cargo", "config.toml"));
    if (cargoConfig && /wasm/.test(cargoConfig)) pushAll(stacks, ["wasm"]);
  }

  // --- CI ----------------------------------------------------------------
  const workflowDir = await listFiles(root, join(".github", "workflows"));
  for (const name of workflowDir) {
    if (!/\.(ya?ml)$/.test(name)) continue;
    await record(join(".github", "workflows", name).split(sep).join("/"), "ci", "");
    pushUnique(ci, name);
    const text = await readTextFile(join(root, ".github", "workflows", name));
    if (text && !testCommands.length) pushUnique(testCommands, "ci-defined");
  }
  for (const name of [".gitlab-ci.yml", "Jenkinsfile"]) {
    if (await record(name, "ci", "")) pushUnique(ci, name);
  }

  // --- App type / platforms (inspection only) -----------------------------
  const appType = classifyAppType({
    stacks,
    dependencies,
    devDependencies,
    languages,
    scripts,
    workspace: manifests.some((manifest) => manifest.kind === "node-workspace"),
  });
  const platforms = classifyPlatforms({ stacks, languages, appType });

  if (!snapshot.revision) {
    uncertainties.push("repository revision unavailable; capability history is not pinned");
  }
  if (!testCommands.length) uncertainties.push("no test command discovered in manifests");

  const fingerprintSha = digest(
    JSON.stringify({
      languages: [...languages].sort(),
      stacks: [...stacks].sort(),
      manifests: manifests.map((manifest) => `${manifest.path}:${manifest.sha256}`).sort(),
    }),
  );

  return {
    root,
    revision: snapshot.revision,
    dirty: snapshot.dirty,
    fingerprintSha,
    languages,
    stacks,
    manifests,
    frameworks,
    dependencies,
    devDependencies,
    packageManagers,
    testCommands,
    buildCommands,
    ci,
    appType,
    platforms,
    tractFiles: snapshot.trackedFiles.length,
    source: snapshot.source,
    uncertainties,
  };
}

interface AppTypeInput {
  stacks: StackTag[];
  dependencies: string[];
  devDependencies: string[];
  languages: string[];
  scripts?: Record<string, unknown> | undefined;
  workspace: boolean;
}

export function classifyAppType(input: AppTypeInput): ProjectFingerprint["appType"] {
  const has = (stack: StackTag) => input.stacks.includes(stack);
  if (has("compiler") || input.languages.includes("tessera")) return "compiler";
  if (has("mobile")) return "mobile";
  if (has("react") && input.devDependencies.some((dep) => /vite/.test(dep))) return "web-app";
  if (has("next")) return "web-app";
  if (input.workspace) return "library";
  if (has("web")) return "web-app";
  if (has("cli")) return "cli";
  if (has("node")) return "service";
  if (input.languages.includes("rust")) return "library";
  if (input.languages.includes("python")) return "service";
  return "unknown";
}

export function classifyPlatforms(input: {
  stacks: StackTag[];
  languages: string[];
  appType: ProjectFingerprint["appType"];
}): string[] {
  const platforms: string[] = [];
  if (input.stacks.includes("web") || input.stacks.includes("react") || input.stacks.includes("next")) {
    platforms.push("browser");
  }
  if (input.stacks.includes("node") || input.appType === "service") platforms.push("server");
  if (input.stacks.includes("wasm")) platforms.push("wasm");
  if (input.languages.includes("tessera")) platforms.push("native");
  if (input.languages.includes("swift") || input.languages.includes("kotlin")) platforms.push("mobile");
  return platforms.length ? platforms : ["cross-platform"];
}

const TASK_CLASS_RULES: Array<{ class: TaskClass; patterns: RegExp; weight?: number }> = [
  { class: "debug", patterns: /\b(debug|stack ?trace|flaky|non-?deterministic|reproduce|repro)\b/i, weight: 3 },
  { class: "bugfix", patterns: /\b(fix|broken|repair|regression|failing|fails|incorrect|wrong|crash)\b/i, weight: 2 },
  { class: "ui", patterns: /\b(ui|ux|layout|css|style|overlap|overlapping|spacing|responsive|accessib\w*|mobile|button|form|modal|design)\b/i, weight: 2 },
  {
    class: "performance",
    patterns: /\b(perf|performance|fast\w*|slow|latency|optimi[sz]e|throughput|memory|cache|profil\w*|benchmark)\b/i,
    weight: 2,
  },
  { class: "security", patterns: /\b(secur\w*|vulnerab\w*|cve|xss|csrf|injection|sanitis|sanitiz|auth\w*|permission\w*|secret\w*)\b/i, weight: 3 },
  { class: "upgrade", patterns: /\b(upgrade|migrat\w*|bump|version|deprecat\w*|breaking change)\b/i, weight: 2 },
  { class: "refactor", patterns: /\b(refactor|restructure|rename|extract|simplify|clean ?up|dead code|duplicat\w*)\b/i, weight: 2 },
  { class: "test", patterns: /\b(test|coverage|spec|unit test|e2e|integration test)\b/i, weight: 2 },
  { class: "docs", patterns: /\b(doc\w*|readme|comment|jsdoc|changelog)\b/i, weight: 2 },
  { class: "research", patterns: /\b(research|investigate|survey|compare|evaluat\w*|spike|prototype)\b/i, weight: 2 },
  { class: "feature", patterns: /\b(add|implement|build|create|support|enable|introduce|new feature)\b/i, weight: 1 },
];

/**
 * Lexical task classification. Deterministic so the same task always yields the
 * same class, and it never overrides inspected repository facts.
 */
export function classifyTask(task: string): { class: TaskClass; confidence: number; matched: string[] } {
  const scores = new Map<TaskClass, number>();
  const matched: string[] = [];
  for (const rule of TASK_CLASS_RULES) {
    const hits = task.match(new RegExp(rule.patterns.source, "gi"));
    if (!hits) continue;
    scores.set(rule.class, (scores.get(rule.class) ?? 0) + hits.length * (rule.weight ?? 1));
    matched.push(rule.class);
  }
  if (!scores.size) return { class: "unknown", confidence: 0, matched: [] };
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0]!;
  const total = ranked.reduce((sum, entry) => sum + entry[1], 0);
  return {
    class: top[0],
    confidence: Math.min(1, top[1] / Math.max(1, total)),
    matched: [...new Set(matched)],
  };
}
