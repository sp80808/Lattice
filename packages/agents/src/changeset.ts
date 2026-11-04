import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  canonicalJson,
  digest,
  runCommand,
  type CommandResult,
} from "@lattice/execution";

/**
 * A candidate's changes are captured before verification and recaptured after
 * it. The identity is derived from the complete worktree bytes and file types,
 * never from the (bounded, possibly truncated) display patch.
 *
 * `lattice.changeset/v1` only covers worktree state. The Git index is not part
 * of the identity: a worker may stage its own edits, but promotion resets the
 * index and stages exactly the captured paths.
 */
export interface ChangeSetEntry {
  /** Path after the change (the new path for a rename or copy). */
  path: string;
  /** Old path for a rename or copy. */
  oldPath?: string;
  /**
   * Capture emits `deleted` + `added` for a rename so the manifest is stable
   * before and after staging. The rename/copy variants remain in the schema
   * for callers that parse raw diffs with detection enabled.
   */
  status:
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "copied"
    | "typechange"
    | "unmerged";
  kind: "file" | "symlink" | "submodule" | "missing" | "other";
  modeBefore?: string;
  modeAfter?: string;
  /** sha256 of the complete file bytes, or of the symlink target / gitlink id. */
  contentDigest?: string;
  size?: number;
  symlinkTarget?: string;
  /** Git's own heuristic: the first 8 KiB contain a NUL byte. */
  binary?: boolean;
  /** The file exceeded the capture policy and was not hashed in full. */
  oversized?: boolean;
  /** Git blob object ids for tracked entries; absent for new untracked files. */
  gitBlobBefore?: string;
  gitBlobAfter?: string;
}

/** Entry kinds a candidate may introduce; all three are opt-in. */
export interface ChangeSetPolicy {
  /** Default `deny`: a new or changed symlink makes the run ineligible. */
  symlinks?: "deny" | "allow";
  /** Default `deny`: submodule/gitlink changes can execute other repositories. */
  submodules?: "deny" | "allow";
  /** Default `deny`: an unmerged path cannot be committed deterministically. */
  unmerged?: "deny" | "allow";
  /** Largest file captured in full. Larger files are recorded but not hashed. */
  maxFileBytes?: number;
  /** Upper bound on manifest entries; beyond it the capture is truncated. */
  maxEntries?: number;
}

export type ChangeSetPolicyResolved = Required<ChangeSetPolicy>;

export const DEFAULT_CHANGE_POLICY: ChangeSetPolicyResolved = {
  symlinks: "deny",
  submodules: "deny",
  unmerged: "deny",
  maxFileBytes: 64 * 1024 * 1024,
  maxEntries: 2_000,
};

export function resolveChangePolicy(
  policy: ChangeSetPolicy = {},
): ChangeSetPolicyResolved {
  return { ...DEFAULT_CHANGE_POLICY, ...policy };
}

export interface WorkspaceChangeSet {
  scheme: "lattice.changeset/v1";
  /** Resolved commit the worktree was created from. */
  baseRevision: string;
  entries: ChangeSetEntry[];
  /** Entries discovered before any policy truncation. */
  entryCount: number;
  entriesTruncated: boolean;
  /** Content-addressed identity; see the module comment. */
  changeSetDigest: string;
  /** Digest of the captured display patch, which may be truncated. */
  patchDigest: string;
  patchTruncated: boolean;
}

export interface WorkspaceChanges {
  changedFiles: string[];
  untrackedFiles: string[];
  /** Bounded human-readable rendering; never the change-set identity. */
  diff: string;
  changeSet: WorkspaceChangeSet;
}

export interface CaptureWorkspaceOptions {
  /** Commit to compare the worktree with. Defaults to HEAD. */
  baseRevision?: string;
  /** Capture limits (file size and entry count). */
  policy?: ChangeSetPolicy;
  /** Bound for the display patch. Default 2 MiB. */
  maxPatchBytes?: number;
}

/**
 * False when Git is configured to ignore the executable bit (common on
 * Windows). New files must then be recorded as 100644 so the manifest does not
 * change when staging normalizes the mode.
 */
export async function gitHonorsFileMode(workspace: string): Promise<boolean> {
  const result = await runCommand({
    command: "git",
    args: ["config", "--bool", "core.filemode"],
    cwd: workspace,
    timeoutMs: 10_000,
  });
  return result.exitCode !== 0 || result.stdout.trim() !== "false";
}

export class WorkspaceCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceCaptureError";
  }
}

function git(
  cwd: string,
  args: string[],
  maxOutputBytes = 8_000_000,
): Promise<CommandResult> {
  return runCommand({
    command: "git",
    args,
    cwd,
    timeoutMs: 60_000,
    maxOutputBytes,
  });
}

async function gitOrThrow(
  cwd: string,
  args: string[],
  maxOutputBytes?: number,
): Promise<CommandResult> {
  const result = await git(cwd, args, maxOutputBytes);
  if (result.exitCode !== 0) {
    throw new WorkspaceCaptureError(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result;
}

interface RawEntry {
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  status: ChangeSetEntry["status"];
  path: string;
  oldPath?: string;
}

const RAW_STATUS: Record<string, ChangeSetEntry["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange",
  U: "unmerged",
};

/**
 * Parse `git diff --raw -z` output. Records are
 * `:oldmode newmode oldsha newsha status\0path\0`, with the original path
 * before the new one for renames and copies. Nothing is whitespace-split, so
 * spaces, newlines and unicode in filenames survive.
 */
export function parseRawDiff(stdout: string): RawEntry[] {
  const tokens = stdout.split("\0");
  const entries: RawEntry[] = [];
  let index = 0;

  while (index < tokens.length) {
    const header = tokens[index++];
    if (!header) continue;
    if (!header.startsWith(":")) {
      throw new WorkspaceCaptureError(`Unparseable raw diff record: ${header.slice(0, 80)}`);
    }
    const fields = header.slice(1).split(" ");
    if (fields.length !== 5) {
      throw new WorkspaceCaptureError(`Unparseable raw diff header: ${header.slice(0, 120)}`);
    }
    const [oldMode, newMode, oldOid, newOid, statusField] = fields as [
      string,
      string,
      string,
      string,
      string,
    ];
    const letter = statusField[0] ?? "";
    const status = RAW_STATUS[letter];
    if (!status) {
      throw new WorkspaceCaptureError(`Unknown raw diff status: ${statusField}`);
    }
    const first = tokens[index++];
    if (first === undefined) throw new WorkspaceCaptureError("Truncated raw diff paths");
    const second = status === "renamed" || status === "copied" ? tokens[index++] : undefined;
    if ((status === "renamed" || status === "copied") && second === undefined) {
      throw new WorkspaceCaptureError("Truncated rename/copy paths");
    }
    entries.push({
      oldMode,
      newMode,
      oldOid,
      newOid,
      status,
      path: second ?? first,
      ...(second !== undefined ? { oldPath: first } : {}),
    });
  }
  return entries;
}

function zeroOid(oid: string): boolean {
  return /^0+$/.test(oid);
}

function gitModeFor(executable: boolean): string {
  return executable ? "100755" : "100644";
}

interface InspectedPath {
  kind: ChangeSetEntry["kind"];
  mode?: string;
  contentDigest?: string;
  size?: number;
  binary?: boolean;
  symlinkTarget?: string;
  oversized?: boolean;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function inspectRegularFile(
  path: string,
  maxFileBytes: number,
): Promise<InspectedPath> {
  // O_NOFOLLOW makes a last-moment symlink swap fail instead of reading a
  // target outside the worktree.
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw new WorkspaceCaptureError(
      `Cannot read ${path} without following symlinks: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const first = await handle.stat({ bigint: true });
    if (!first.isFile()) {
      throw new WorkspaceCaptureError(`${path} changed type while it was being captured`);
    }
    if (first.size > BigInt(maxFileBytes)) {
      return { kind: "file", size: Number(first.size), oversized: true };
    }

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const head: Buffer[] = [];
    let headBytes = 0;
    let size = 0;
    let oversized = false;

    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > maxFileBytes) {
        // Do not read an unbounded file just to identify it.
        oversized = true;
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (headBytes < 8192) {
        const part = Buffer.from(chunk.subarray(0, 8192 - headBytes));
        head.push(part);
        headBytes += part.length;
      }
    }

    const last = await handle.stat({ bigint: true });
    if (
      first.size !== last.size ||
      first.mtimeNs !== last.mtimeNs ||
      first.ino !== last.ino
    ) {
      throw new WorkspaceCaptureError(`${path} changed while it was being captured`);
    }
    if (oversized) {
      return { kind: "file", size, oversized: true };
    }

    const headBuffer = Buffer.concat(head);
    return {
      kind: "file",
      contentDigest: hash.digest("hex"),
      size,
      binary: headBuffer.includes(0),
    };
  } finally {
    await handle.close();
  }
}

async function inspectPath(
  workspaceRoot: string,
  relPath: string,
  maxFileBytes: number,
): Promise<InspectedPath> {
  const absolute = resolve(workspaceRoot, relPath);
  if (!isInside(workspaceRoot, absolute)) {
    throw new WorkspaceCaptureError(`Changed path escapes the worktree: ${relPath}`);
  }

  let first;
  try {
    first = await lstat(absolute, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    throw error;
  }

  if (first.isSymbolicLink()) {
    const target = await readlink(absolute);
    const again = await lstat(absolute, { bigint: true });
    if (
      !again.isSymbolicLink() ||
      again.ino !== first.ino ||
      again.mtimeNs !== first.mtimeNs
    ) {
      throw new WorkspaceCaptureError(`${relPath} changed while it was being captured`);
    }
    return {
      kind: "symlink",
      mode: "120000",
      symlinkTarget: target,
      contentDigest: digest(`symlink\0${target}`),
      size: Buffer.byteLength(target),
    };
  }

  if (first.isFile()) {
    const inspected = await inspectRegularFile(absolute, maxFileBytes);
    return {
      ...inspected,
      mode: gitModeFor((Number(first.mode) & 0o111) !== 0),
    };
  }

  if (first.isDirectory()) {
    return { kind: "submodule", mode: "160000" };
  }

  return {
    kind: "other",
    mode: String(first.mode),
  };
}

function entryIdentity(entry: ChangeSetEntry): Record<string, unknown> {
  return {
    path: entry.path,
    oldPath: entry.oldPath,
    status: entry.status,
    kind: entry.kind,
    modeBefore: entry.modeBefore,
    modeAfter: entry.modeAfter,
    contentDigest: entry.contentDigest,
    size: entry.size,
    symlinkTarget: entry.symlinkTarget,
    binary: entry.binary,
    oversized: entry.oversized,
  };
}

export function changeSetDigest(changeSet: {
  baseRevision: string;
  entries: ChangeSetEntry[];
  entryCount: number;
  entriesTruncated: boolean;
}): string {
  const entries = [...changeSet.entries]
    .sort((a, b) =>
      a.path === b.path
        ? (a.oldPath ?? "").localeCompare(b.oldPath ?? "")
        : a.path.localeCompare(b.path),
    )
    .map(entryIdentity);
  return digest(
    canonicalJson({
      scheme: "lattice.changeset/v1",
      baseRevision: changeSet.baseRevision,
      entries,
      entryCount: changeSet.entryCount,
      entriesTruncated: changeSet.entriesTruncated,
    }),
  );
}

export function emptyChangeSet(baseRevision: string): WorkspaceChangeSet {
  const changeSet = {
    scheme: "lattice.changeset/v1" as const,
    baseRevision,
    entries: [],
    entryCount: 0,
    entriesTruncated: false,
    changeSetDigest: "",
    patchDigest: digest(""),
    patchTruncated: false,
  };
  return { ...changeSet, changeSetDigest: changeSetDigest(changeSet) };
}

export function emptyWorkspaceChanges(baseRevision: string): WorkspaceChanges {
  return {
    changedFiles: [],
    untrackedFiles: [],
    diff: "",
    changeSet: emptyChangeSet(baseRevision),
  };
}

/**
 * Capture the complete candidate: every changed and untracked path as a typed,
 * content-addressed entry, plus a bounded unified patch for display.
 *
 * The patch is a rendering. Two candidates are identical only when their
 * `changeSetDigest` values match, which is derived from full bytes and modes.
 */
export async function captureWorkspaceChanges(
  workspace: string,
  options: CaptureWorkspaceOptions = {},
): Promise<WorkspaceChanges> {
  const policy = resolveChangePolicy(options.policy);
  const maxPatchBytes = options.maxPatchBytes ?? 2 * 1024 * 1024;
  const workspaceRoot = await realpath(resolve(workspace));
  const topLevel = await realpath(
    (
      await gitOrThrow(workspaceRoot, ["rev-parse", "--show-toplevel"])
    ).stdout.trim(),
  );
  if (topLevel !== workspaceRoot) {
    throw new WorkspaceCaptureError(
      `Capture requires the repository top level, not ${workspaceRoot}`,
    );
  }
  const honorFileMode = await gitHonorsFileMode(workspaceRoot);

  const base = (
    await gitOrThrow(workspaceRoot, [
      "rev-parse",
      "--verify",
      `${options.baseRevision ?? "HEAD"}^{commit}`,
    ])
  ).stdout.trim();

  // No rename detection: a rename is a delete plus an add. That shape is
  // identical before and after staging, so verification cannot be invalidated
  // merely by promoting the same bytes through the index.
  const raw = await gitOrThrow(workspaceRoot, [
    "diff",
    "--raw",
    "--no-renames",
    "-z",
    "--no-abbrev",
    "--no-ext-diff",
    "--no-textconv",
    base,
    "--",
  ]);
  if (raw.outputTruncated) {
    throw new WorkspaceCaptureError("Raw change list exceeded the capture limit");
  }

  const untrackedResult = await gitOrThrow(workspaceRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (untrackedResult.outputTruncated) {
    throw new WorkspaceCaptureError("Untracked file list exceeded the capture limit");
  }
  const untracked = untrackedResult.stdout.split("\0").filter(Boolean).sort();

  const entries: ChangeSetEntry[] = [];
  for (const rawEntry of parseRawDiff(raw.stdout)) {
    const inspected =
      rawEntry.status === "deleted"
        ? ({ kind: "missing" } satisfies InspectedPath)
        : await inspectPath(workspaceRoot, rawEntry.path, policy.maxFileBytes);
    const kind =
      rawEntry.newMode === "160000" ||
      (rawEntry.status === "deleted" && rawEntry.oldMode === "160000")
        ? "submodule"
        : inspected.kind;
    const contentDigest =
      kind === "submodule"
        ? digest(
            `gitlink\0${zeroOid(rawEntry.newOid) ? rawEntry.oldOid : rawEntry.newOid}`,
          )
        : inspected.contentDigest;
    entries.push({
      path: rawEntry.path,
      ...(rawEntry.oldPath !== undefined ? { oldPath: rawEntry.oldPath } : {}),
      status: rawEntry.status,
      kind,
      ...(zeroOid(rawEntry.oldMode) ? {} : { modeBefore: rawEntry.oldMode }),
      ...(zeroOid(rawEntry.newMode) ? {} : { modeAfter: rawEntry.newMode }),
      ...(contentDigest !== undefined ? { contentDigest } : {}),
      ...(inspected.size !== undefined ? { size: inspected.size } : {}),
      ...(inspected.symlinkTarget !== undefined
        ? { symlinkTarget: inspected.symlinkTarget }
        : {}),
      ...(inspected.binary !== undefined ? { binary: inspected.binary } : {}),
      ...(inspected.oversized ? { oversized: true } : {}),
      ...(zeroOid(rawEntry.oldOid) ? {} : { gitBlobBefore: rawEntry.oldOid }),
      ...(zeroOid(rawEntry.newOid) ? {} : { gitBlobAfter: rawEntry.newOid }),
    });
  }

  for (const path of untracked) {
    const inspected = await inspectPath(workspaceRoot, path, policy.maxFileBytes);
    entries.push({
      path,
      status: "added",
      kind: inspected.kind,
      ...(inspected.mode !== undefined
        ? {
            modeAfter:
              inspected.kind === "file" && !honorFileMode
                ? "100644"
                : inspected.mode,
          }
        : {}),
      ...(inspected.contentDigest !== undefined
        ? { contentDigest: inspected.contentDigest }
        : {}),
      ...(inspected.size !== undefined ? { size: inspected.size } : {}),
      ...(inspected.symlinkTarget !== undefined
        ? { symlinkTarget: inspected.symlinkTarget }
        : {}),
      ...(inspected.binary !== undefined ? { binary: inspected.binary } : {}),
      ...(inspected.oversized ? { oversized: true } : {}),
    });
  }

  entries.sort((a, b) =>
    a.path === b.path
      ? (a.oldPath ?? "").localeCompare(b.oldPath ?? "")
      : a.path.localeCompare(b.path),
  );
  const entryCount = entries.length;
  const entriesTruncated = entryCount > policy.maxEntries;
  const kept = entriesTruncated ? entries.slice(0, policy.maxEntries) : entries;

  // Tracked changes first; untracked file contents are rendered one file at a
  // time so a large candidate cannot make the run log unbounded.
  const trackedPatch = await git(workspaceRoot, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    base,
    "--",
  ], maxPatchBytes);
  let patch = trackedPatch.stdout;
  let patchTruncated = trackedPatch.outputTruncated;

  for (const path of untracked) {
    const remaining = maxPatchBytes - Buffer.byteLength(patch);
    if (remaining <= 0) {
      patchTruncated = true;
      break;
    }
    const added = await runCommand({
      command: "git",
      args: [
        "diff",
        "--no-ext-diff",
        "--binary",
        "--no-textconv",
        "--no-index",
        "--",
        "/dev/null",
        path,
      ],
      cwd: workspaceRoot,
      maxOutputBytes: remaining,
    });
    if (added.exitCode !== 0 && added.exitCode !== 1) {
      throw new WorkspaceCaptureError(
        `Cannot render added file ${path}: ${added.stderr.trim() || added.stdout.trim()}`,
      );
    }
    patch += added.stdout;
    patchTruncated ||= added.outputTruncated;
  }

  const changeSetBase = {
    scheme: "lattice.changeset/v1" as const,
    baseRevision: base,
    entries: kept,
    entryCount,
    entriesTruncated,
    patchDigest: digest(patch),
    patchTruncated,
  };
  const changeSet: WorkspaceChangeSet = {
    ...changeSetBase,
    changeSetDigest: changeSetDigest(changeSetBase),
  };

  return {
    changedFiles: kept.map((entry) => entry.path),
    untrackedFiles: untracked,
    diff: patch,
    changeSet,
  };
}

export type ChangePolicyViolationCode =
  | "symlink"
  | "symlink-escape"
  | "submodule"
  | "unmerged"
  | "unsupported-type"
  | "oversized-file"
  | "too-many-changes"
  | "path-escape";

export interface ChangePolicyViolation {
  code: ChangePolicyViolationCode;
  path?: string;
  message: string;
}

/**
 * Check a captured candidate against the change policy. Path containment is
 * enforced independently of `symlinks`: an allowed in-repository symlink is
 * fine, a link that leaves the worktree is not. Parent directories are
 * resolved with `realpath`, so a tracked directory replaced by an external
 * symlink cannot smuggle later writes past the check.
 */
export async function evaluateChangeSet(
  changeSet: WorkspaceChangeSet,
  workspace: string,
  policyInput: ChangeSetPolicy = {},
): Promise<ChangePolicyViolation[]> {
  const policy = resolveChangePolicy(policyInput);
  const root = await realpath(resolve(workspace));
  const violations: ChangePolicyViolation[] = [];
  const parentCache = new Map<string, boolean>();

  if (changeSet.entriesTruncated) {
    violations.push({
      code: "too-many-changes",
      message: `Candidate changed more than ${policy.maxEntries} paths`,
    });
  }

  const checkParent = async (path: string): Promise<void> => {
    const absolute = resolve(root, path);
    if (!isInside(root, absolute)) {
      violations.push({
        code: "path-escape",
        path,
        message: `${path} resolves outside the worktree`,
      });
      return;
    }
    const parent = dirname(absolute);
    let inside = parentCache.get(parent);
    if (inside === undefined) {
      try {
        inside = isInside(root, await realpath(parent));
      } catch (error) {
        // A deleted entry may leave no parent to resolve; the lexical check
        // above still holds. Any other failure (permissions, symlink loop)
        // fails closed.
        inside = (error as NodeJS.ErrnoException).code === "ENOENT";
      }
      parentCache.set(parent, inside);
    }
    if (!inside) {
      violations.push({
        code: "path-escape",
        path,
        message: `${path} is under a directory that resolves outside the worktree`,
      });
    }
  };

  for (const entry of changeSet.entries) {
    await checkParent(entry.path);

    if (entry.kind === "other") {
      violations.push({
        code: "unsupported-type",
        path: entry.path,
        message: `${entry.path} is not a regular file, symlink or submodule`,
      });
    }
    if (entry.oversized) {
      violations.push({
        code: "oversized-file",
        path: entry.path,
        message: `${entry.path} exceeds ${policy.maxFileBytes} bytes and was not captured in full`,
      });
    }
    if (entry.status === "unmerged" && policy.unmerged === "deny") {
      violations.push({
        code: "unmerged",
        path: entry.path,
        message: `${entry.path} is unmerged`,
      });
    }
    if (entry.kind === "submodule" && policy.submodules === "deny") {
      violations.push({
        code: "submodule",
        path: entry.path,
        message: `${entry.path} changes a submodule`,
      });
    }
    if (entry.kind === "symlink") {
      if (policy.symlinks === "deny") {
        violations.push({
          code: "symlink",
          path: entry.path,
          message: `${entry.path} introduces or changes a symlink`,
        });
      }
      if (entry.symlinkTarget !== undefined) {
        const target = isAbsolute(entry.symlinkTarget)
          ? resolve(entry.symlinkTarget)
          : resolve(dirname(resolve(root, entry.path)), entry.symlinkTarget);
        if (!isInside(root, target)) {
          violations.push({
            code: "symlink-escape",
            path: entry.path,
            message: `${entry.path} points outside the worktree (${entry.symlinkTarget})`,
          });
        }
      }
    }
  }

  return violations;
}

export interface ChangeSetDrift {
  changed: boolean;
  added: string[];
  removed: string[];
  modified: string[];
  /** Present when truncation changed, which the per-path lists cannot show. */
  entryCountBefore?: number;
  entryCountAfter?: number;
}

/** Path-level difference between the captured and recaptured candidate. */
export function diffChangeSets(
  before: WorkspaceChangeSet,
  after: WorkspaceChangeSet,
): ChangeSetDrift {
  const beforeMap = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterMap = new Map(after.entries.map((entry) => [entry.path, entry]));
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];

  for (const [path, entry] of afterMap) {
    const previous = beforeMap.get(path);
    if (!previous) added.push(path);
    else if (
      canonicalJson(entryIdentity(previous)) !== canonicalJson(entryIdentity(entry))
    ) {
      modified.push(path);
    }
  }
  for (const path of beforeMap.keys()) {
    if (!afterMap.has(path)) removed.push(path);
  }

  added.sort();
  removed.sort();
  modified.sort();
  const countsChanged = before.entryCount !== after.entryCount;
  return {
    changed:
      before.changeSetDigest !== after.changeSetDigest ||
      countsChanged ||
      added.length > 0 ||
      removed.length > 0 ||
      modified.length > 0,
    added,
    removed,
    modified,
    ...(countsChanged
      ? { entryCountBefore: before.entryCount, entryCountAfter: after.entryCount }
      : {}),
  };
}

export interface WorktreeMetadataSnapshot {
  head: string;
  gitDir: string;
  toplevel: string;
  /** Digest of the worktree's `.git` file; undefined for a normal checkout. */
  gitFileDigest?: string;
}

export async function snapshotWorktreeMetadata(
  workspace: string,
): Promise<WorktreeMetadataSnapshot> {
  const root = await realpath(resolve(workspace));
  const result = await gitOrThrow(root, [
    "rev-parse",
    "--absolute-git-dir",
    "--show-toplevel",
    "HEAD",
  ]);
  const [gitDir, toplevel, head] = result.stdout.trim().split("\n");
  if (!gitDir || !toplevel || !head) {
    throw new WorkspaceCaptureError("git rev-parse did not report the worktree layout");
  }

  const dotGit = join(root, ".git");
  let gitFileDigest: string | undefined;
  try {
    const info = await lstat(dotGit);
    if (info.isFile()) {
      gitFileDigest = digest(await readFile(dotGit, "utf8"));
    }
  } catch {
    // A missing .git file is reported through gitDir/toplevel instead.
  }

  return {
    head,
    gitDir: await realpath(gitDir),
    toplevel: await realpath(toplevel),
    ...(gitFileDigest !== undefined ? { gitFileDigest } : {}),
  };
}

/**
 * Differences that mean the worktree's Git wiring was tampered with. HEAD is
 * deliberately excluded: a worker commit is reported separately as `headMoved`
 * so callers can explain it.
 */
export function worktreeMetadataChanges(
  before: WorktreeMetadataSnapshot,
  after: WorktreeMetadataSnapshot,
): string[] {
  const changes: string[] = [];
  if (before.gitDir !== after.gitDir) changes.push("git directory moved");
  if (before.toplevel !== after.toplevel) changes.push("worktree top level moved");
  if (before.gitFileDigest !== after.gitFileDigest) changes.push(".git file changed");
  return changes;
}
