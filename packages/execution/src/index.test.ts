import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectRepositorySnapshot,
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

test("runCommand times out a hanging script without waiting it out", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-exec-timeout-"));
  const script = join(cwd, "hang.sh");
  await writeFile(script, "#!/bin/bash\nsleep 30\n");
  await chmod(script, 0o755);

  const started = performance.now();
  const result = await runCommand({ command: script, timeoutMs: 200 });
  assert.equal(result.timedOut, true);
  assert.ok(performance.now() - started < 5_000, "must not wait out the fake sleep");
});

test("a nested `node --test` is not neutralised by the parent test runner's environment", async () => {
  // This suite itself runs under `node --test`, which sets NODE_TEST_CONTEXT. If that leaked
  // into the child, a *failing* test file would exit 0 without running: a vacuous pass.
  const dir = await mkdtemp(join(tmpdir(), "lattice-nested-"));
  await writeFile(join(dir, "failing.test.js"), 'import test from "node:test";\ntest("fails", () => { throw new Error("boom"); });\n');
  await writeFile(join(dir, "package.json"), '{"type":"module"}');

  const result = await runCommand({ command: process.execPath, args: ["--test", "failing.test.js"], cwd: dir });
  assert.notEqual(result.exitCode, 0, "a failing nested test must fail");
  assert.match(result.stdout, /fail 1/);

  // Explicit opt-in still works for callers that really want the context.
  const inherited = await runCommand({
    command: process.execPath,
    args: ["-e", "process.stdout.write(String(process.env.NODE_TEST_CONTEXT))"],
    env: { NODE_TEST_CONTEXT: "explicit" },
  });
  assert.equal(inherited.stdout, "explicit");
  const cleared = await runCommand({
    command: process.execPath,
    args: ["-e", "process.stdout.write(String(process.env.NODE_TEST_CONTEXT))"],
  });
  assert.equal(cleared.stdout, "undefined");
});
