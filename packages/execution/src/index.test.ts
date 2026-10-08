import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalJson,
  collectRepositorySnapshot,
  commandEvidenceIdentity,
  digest,
  runCommand,
} from "./index.js";

test("runCommand captures objective process evidence", async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", "process.stdout.write('ok')"],
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.timedOut, false);
});

test("runCommand can provide stdin without enabling a shell", async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", "process.stdin.pipe(process.stdout)"],
    stdin: "from-stdin",
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "from-stdin");
});

test("collectRepositorySnapshot falls back to filesystem facts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-exec-"));
  await writeFile(join(cwd, "alpha.ts"), "export const alpha = 1;\n");

  const snapshot = await collectRepositorySnapshot(cwd);
  assert.equal(snapshot.root, cwd);
  assert.ok(snapshot.trackedFiles.includes("alpha.ts"));
});

test("digest is deterministic", () => {
  assert.equal(digest("same"), digest("same"));
  assert.notEqual(digest("same"), digest("different"));
});

test("command identity ignores timing and cwd but not full output or revision", async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(64))"],
    maxOutputBytes: 8,
  });
  assert.equal(result.outputTruncated, true);
  assert.equal(result.stdout, "x".repeat(8));
  // The digest covers the whole stream, not the captured prefix.
  assert.equal(result.stdoutSha256, digest("x".repeat(64)));

  const base = commandEvidenceIdentity(result, "abc");
  assert.match(base.id, /^ev1:/);
  assert.equal(
    commandEvidenceIdentity({ ...result, durationMs: 99_999, cwd: "/elsewhere" }, "abc").id,
    base.id,
  );
  assert.notEqual(commandEvidenceIdentity(result, "def").id, base.id);
  assert.notEqual(
    commandEvidenceIdentity({ ...result, stdoutSha256: digest("y") }, "abc").id,
    base.id,
  );
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});
