import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCommand } from "@lattice/execution";
import {
  captureWorkspaceChanges,
  diffChangeSets,
  evaluateChangeSet,
  parseRawDiff,
  type ChangeSetEntry,
} from "./changeset.js";

async function git(repo: string, args: string[]) {
  const result = await runCommand({ command: "git", args, cwd: repo });
  assert.equal(result.exitCode, 0, `${args.join(" ")}: ${result.stderr}`);
  return result;
}

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "lattice-changeset-repo-"));
  await git(repo, ["init", "-q"]);
  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, ["add", "base.txt"]);
  await git(repo, [
    "-c",
    "user.name=Lattice Test",
    "-c",
    "user.email=lattice@example.invalid",
    "commit",
    "-qm",
    "initial",
  ]);
  return repo;
}

function entry(entries: ChangeSetEntry[], path: string): ChangeSetEntry {
  const found = entries.find((candidate) => candidate.path === path);
  assert.ok(found, `missing entry for ${path}: ${entries.map((e) => e.path).join(", ")}`);
  return found;
}

const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

test("capture records full digests for untracked text, binary and executable files", async () => {
  const repo = await createRepo();
  await writeFile(join(repo, "notes.txt"), "cloth mesh\n");
  await writeFile(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(repo, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });

  const changes = await captureWorkspaceChanges(repo);
  const { changeSet } = changes;

  assert.equal(changeSet.baseRevision.length, 40);
  assert.equal(changeSet.entriesTruncated, false);
  assert.deepEqual(changes.untrackedFiles, ["blob.bin", "notes.txt", "run.sh"]);
  assert.deepEqual(
    changes.changedFiles,
    ["blob.bin", "notes.txt", "run.sh"],
  );

  const notes = entry(changeSet.entries, "notes.txt");
  assert.equal(notes.status, "added");
  assert.equal(notes.kind, "file");
  assert.equal(notes.contentDigest, sha256("cloth mesh\n"));
  assert.equal(notes.size, Buffer.byteLength("cloth mesh\n"));
  assert.equal(notes.binary, false);

  const binary = entry(changeSet.entries, "blob.bin");
  assert.equal(binary.binary, true);
  assert.equal(binary.size, 4);
  assert.equal(binary.contentDigest, sha256(Buffer.from([0, 1, 2, 255])));

  const script = entry(changeSet.entries, "run.sh");
  assert.equal(script.modeAfter, "100755");

  // The rendering is bounded display text; the digest is not derived from it.
  assert.match(changes.diff, /\+cloth mesh/);
  assert.match(changes.diff, /GIT binary patch/);
  assert.match(changeSet.patchDigest, /^[0-9a-f]{64}$/);
});

test("renames with spaces and unicode round-trip as delete plus add", async () => {
  const repo = await createRepo();
  await mkdir(join(repo, "docs"));
  await writeFile(
    join(repo, "docs", "old name.txt"),
    "keep every byte\n",
  );
  await git(repo, ["add", "docs"]);
  await git(repo, [
    "-c",
    "user.name=Lattice Test",
    "-c",
    "user.email=lattice@example.invalid",
    "commit",
    "-qm",
    "docs",
  ]);

  await git(repo, ["mv", "docs/old name.txt", "docs/新 name.txt"]);
  const changes = await captureWorkspaceChanges(repo);
  const added = entry(changes.changeSet.entries, "docs/新 name.txt");
  const deleted = entry(changes.changeSet.entries, "docs/old name.txt");

  // A rename is represented as a delete plus an add so the manifest does not
  // change when Git starts seeing an index and similarity heuristics apply.
  assert.equal(added.status, "added");
  assert.equal(added.modeAfter, "100644");
  assert.equal(added.contentDigest, sha256("keep every byte\n"));
  assert.equal(deleted.status, "deleted");
  assert.equal(deleted.modeBefore, "100644");
  assert.deepEqual(changes.changedFiles, ["docs/old name.txt", "docs/新 name.txt"]);
});

test("symlinks are captured with their target and checked for containment", async () => {
  const repo = await createRepo();
  await symlink("base.txt", join(repo, "good-link"));
  await symlink("/etc/passwd", join(repo, "absolute-link"));
  await symlink("../outside.txt", join(repo, "relative-link"));

  const changes = await captureWorkspaceChanges(repo);
  const good = entry(changes.changeSet.entries, "good-link");
  assert.equal(good.kind, "symlink");
  assert.equal(good.symlinkTarget, "base.txt");
  assert.equal(good.contentDigest, sha256("symlink\0base.txt"));
  assert.equal(good.size, Buffer.byteLength("base.txt"));

  const denied = await evaluateChangeSet(changes.changeSet, repo);
  const deniedCodes = denied.map((violation) => `${violation.code}:${violation.path}`);
  assert.ok(deniedCodes.includes("symlink:good-link"));
  assert.ok(deniedCodes.includes("symlink-escape:absolute-link"));
  assert.ok(deniedCodes.includes("symlink-escape:relative-link"));

  const allowed = await evaluateChangeSet(changes.changeSet, repo, {
    symlinks: "allow",
  });
  assert.deepEqual(
    allowed.map((violation) => `${violation.code}:${violation.path}`).sort(),
    ["symlink-escape:absolute-link", "symlink-escape:relative-link"],
  );
});

test("a tracked directory replaced by an outside symlink is a path escape", async () => {
  const repo = await createRepo();
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src", "mod.txt"), "inside\n");
  await git(repo, ["add", "src"]);
  await git(repo, [
    "-c",
    "user.name=Lattice Test",
    "-c",
    "user.email=lattice@example.invalid",
    "commit",
    "-qm",
    "src",
  ]);

  const outside = await mkdtemp(join(tmpdir(), "lattice-outside-"));
  await writeFile(join(outside, "mod.txt"), "inside\n");
  await rm(join(repo, "src"), { recursive: true, force: true });
  await symlink(outside, join(repo, "src"));

  try {
    const changes = await captureWorkspaceChanges(repo);
    const insideEntry = entry(changes.changeSet.entries, "src/mod.txt");
    assert.equal(insideEntry.status, "deleted");

    const violations = await evaluateChangeSet(changes.changeSet, repo, {
      symlinks: "allow",
    });
    const codes = violations.map((violation) => `${violation.code}:${violation.path}`);
    assert.ok(codes.includes("symlink-escape:src"), codes.join(", "));
    assert.ok(codes.includes("path-escape:src/mod.txt"), codes.join(", "));
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("an over-limit candidate is captured but policy-ineligible", async () => {
  const repo = await createRepo();
  for (const name of ["a.txt", "b.txt", "c.txt"]) {
    await writeFile(join(repo, name), name);
  }

  const changes = await captureWorkspaceChanges(repo, {
    policy: { maxEntries: 2 },
  });
  assert.equal(changes.changeSet.entryCount, 3);
  assert.equal(changes.changeSet.entriesTruncated, true);
  assert.equal(changes.changeSet.entries.length, 2);

  const violations = await evaluateChangeSet(
    changes.changeSet,
    repo,
    { maxEntries: 2 },
  );
  assert.ok(violations.some((violation) => violation.code === "too-many-changes"));
});

test("drift names added, removed and modified paths", async () => {
  const repo = await createRepo();
  await writeFile(join(repo, "a.txt"), "one\n");
  await writeFile(join(repo, "b.txt"), "two\n");
  const before = await captureWorkspaceChanges(repo);

  await writeFile(join(repo, "a.txt"), "one changed\n");
  await unlink(join(repo, "b.txt"));
  await writeFile(join(repo, "c.txt"), "three\n");
  const after = await captureWorkspaceChanges(repo);

  const drift = diffChangeSets(before.changeSet, after.changeSet);
  assert.equal(drift.changed, true);
  assert.deepEqual(drift.added, ["c.txt"]);
  assert.deepEqual(drift.removed, ["b.txt"]);
  assert.deepEqual(drift.modified, ["a.txt"]);
});

test("capture refuses a subdirectory of the repository", async () => {
  const repo = await createRepo();
  await mkdir(join(repo, "src"));
  await assert.rejects(
    captureWorkspaceChanges(join(repo, "src")),
    /repository top level/,
  );
});

test("an unchanged worktree produces an identical change-set digest", async () => {
  const repo = await createRepo();
  await writeFile(join(repo, "notes.txt"), "stable\n");
  const first = await captureWorkspaceChanges(repo);
  const second = await captureWorkspaceChanges(repo);
  assert.equal(first.changeSet.changeSetDigest, second.changeSet.changeSetDigest);
  assert.deepEqual(diffChangeSets(first.changeSet, second.changeSet), {
    changed: false,
    added: [],
    removed: [],
    modified: [],
  });
});

test("the raw-diff parser is NUL-safe for newline and dash-prefixed names", async () => {
  if (process.platform === "win32") return; // Windows filenames cannot contain newlines.
  const repo = await createRepo();
  const name = "line\nbreak -ı.txt";
  await writeFile(join(repo, name), "nul-safe\n");

  const changes = await captureWorkspaceChanges(repo);
  assert.ok(changes.changedFiles.includes(name), JSON.stringify(changes.changedFiles));
  assert.ok(changes.untrackedFiles.includes(name));
  assert.equal(entry(changes.changeSet.entries, name).contentDigest, sha256("nul-safe\n"));
});

test("raw diff parsing still understands rename records and rejects malformed input", () => {
  const oldOid = "a".repeat(40);
  const newOid = "b".repeat(40);
  const parsed = parseRawDiff(
    `:100644 100644 ${oldOid} ${newOid} R100\0before.txt\0after.txt\0`,
  );
  assert.deepEqual(parsed, [
    {
      oldMode: "100644",
      newMode: "100644",
      oldOid,
      newOid,
      status: "renamed",
      path: "after.txt",
      oldPath: "before.txt",
    },
  ]);
  assert.throws(() => parseRawDiff("not a raw record"), /Unparseable/);
});
