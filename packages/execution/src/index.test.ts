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
