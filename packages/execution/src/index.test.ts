import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildCommandEnv,
  canonicalJson,
  collectRepositorySnapshot,
  commandEvidenceIdentity,
  digest,
  MINIMAL_ENV_BASE,
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
    assert.ok(result.envNames?.includes("LATTICE_TEST_PROVIDER_KEY"));
    assert.ok(!result.envNames?.includes("LATTICE_TEST_UNRELATED_SECRET"));
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

// Red-team: real credential names a developer shell commonly exports.
const CREDENTIAL_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "SSH_AUTH_SOCK",
];

test("minimal env withholds host credentials from the child and its descendants", async () => {
  const sentinel = "lattice-redteam-sentinel";
  const saved = new Map(CREDENTIAL_NAMES.map((name) => [name, process.env[name]]));
  for (const name of CREDENTIAL_NAMES) process.env[name] = `${sentinel}-${name}`;
  try {
    // The grandchild inherits the child's environment, so it sees exactly
    // what the policy let through.
    const grandchild = `process.stdout.write(JSON.stringify(Object.entries(process.env).filter(([,v])=>String(v).includes(${JSON.stringify(sentinel)})).map(([k])=>k)))`;
    const result = await runCommand({
      command: process.execPath,
      args: [
        "-e",
        `process.stdout.write(require('child_process').execFileSync(process.execPath,['-e',${JSON.stringify(grandchild)}]))`,
      ],
      envPolicy: "minimal",
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), []);
    for (const name of CREDENTIAL_NAMES) assert.ok(!result.envNames?.includes(name), name);

    // Only an explicit allowlist entry lets one through, by name.
    const granted = await runCommand({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.OPENROUTER_API_KEY ?? '')"],
      envPolicy: "minimal",
      allowEnv: ["OPENROUTER_API_KEY"],
    });
    assert.equal(granted.stdout, `${sentinel}-OPENROUTER_API_KEY`);
    assert.ok(!JSON.stringify(granted).replace(granted.stdout, "").includes(sentinel));
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("the minimal base allowlist names no credential-like variable", () => {
  for (const name of MINIMAL_ENV_BASE) {
    assert.doesNotMatch(name, /KEY|TOKEN|SECRET|PASS|AUTH|CRED|SESSION|COOKIE|BASE_URL/i, name);
  }
});

test("a timed-out tree leaves no orphan writes behind", { skip: !posix }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "lattice-orphan-"));
  const late = join(dir, "late-write");
  // The grandchild would write after the timeout; it must die with the group.
  const result = await runCommand({
    command: process.execPath,
    args: [
      "-e",
      `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(late)},'x'),1500)`)}],{stdio:'ignore'});setInterval(()=>{},1000);`,
    ],
    killTree: true,
    timeoutMs: 300,
    killGraceMs: 100,
  });
  assert.equal(result.timedOut, true);
  await new Promise((r) => setTimeout(r, 2_500));
  await assert.rejects(readFile(late), /ENOENT/);
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
