import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildCommandEnv,
  collectRepositorySnapshot,
  digest,
  runCommand,
} from "./index.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

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

test("minimal env policy hides unrelated parent secrets", async () => {
  process.env.LATTICE_TEST_UNRELATED_SECRET = "do-not-leak";
  process.env.LATTICE_TEST_PROVIDER_KEY = "granted";
  try {
    const result = await runCommand({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({s:process.env.LATTICE_TEST_UNRELATED_SECRET??null,k:process.env.LATTICE_TEST_PROVIDER_KEY??null,x:process.env.EXPLICIT??null}))",
      ],
      envPolicy: "minimal",
      allowEnv: ["LATTICE_TEST_PROVIDER_KEY"],
      env: { EXPLICIT: "yes" },
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { s: null, k: "granted", x: "yes" });
    assert.equal(result.envPolicy, "minimal");
    assert.ok(result.envNames.includes("LATTICE_TEST_PROVIDER_KEY"));
    assert.ok(!result.envNames.includes("LATTICE_TEST_UNRELATED_SECRET"));
    assert.ok(!JSON.stringify(result.envNames).includes("granted"));
  } finally {
    delete process.env.LATTICE_TEST_UNRELATED_SECRET;
    delete process.env.LATTICE_TEST_PROVIDER_KEY;
  }
});

test("inherit stays the default for trusted tooling", () => {
  const env = buildCommandEnv("inherit", [], { DROP: undefined }, { A: "1", DROP: "x" });
  assert.deepEqual(env, { A: "1" });
  assert.deepEqual(buildCommandEnv("minimal", [], {}, { A: "1", PATH: "/bin" }), {
    PATH: "/bin",
  });
});

const posix = process.platform !== "win32";

test("killTree reaps a background descendant once the command exits", { skip: !posix }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "lattice-tree-"));
  const pidFile = join(dir, "pid");
  // The leader spawns a detached-from-stdio sleeper and exits at once.
  const result = await runCommand({
    command: process.execPath,
    args: [
      "-e",
      `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();`,
    ],
    killTree: true,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.equal(result.descendantsKilled, true);
  assert.ok(await waitFor(() => !alive(pid)), `descendant ${pid} survived`);
});

test("killTree timeout kills descendants holding the output pipe", { skip: !posix }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "lattice-tree-"));
  const pidFile = join(dir, "pid");
  const started = Date.now();
  const result = await runCommand({
    command: process.execPath,
    args: [
      "-e",
      `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`,
    ],
    killTree: true,
    timeoutMs: 500,
    killGraceMs: 200,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5_000, "timeout was not bounded");
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.ok(await waitFor(() => !alive(pid)), `descendant ${pid} survived`);
});
