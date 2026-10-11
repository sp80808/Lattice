import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runTask } from "./index.js";
import { readPlanSources } from "./planning.js";
import type { GeneratorRequest } from "@lattice/protocol";

test("runTask records repository evidence before completion", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-"));
  const result = await runTask("inspect this repository", { cwd });

  assert.equal(result.status, "completed");
  assert.equal(result.tap.task, "inspect this repository");
  assert.equal(result.tap.version, "0.1");
  assert.equal(result.tap.evidence[0]?.kind, "repository");
  assert.equal(result.tap.evidence[0]?.verified, true);

  const log = await readFile(result.eventLogPath, "utf8");
  const events = log.trim().split("\n").map((line) => JSON.parse(line));

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "run.started",
      "tool.started",
      "tool.completed",
      "tap.created",
      "run.completed",
    ],
  );
});

test("runTask can attach explicit command verification", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-"));
  const result = await runTask("verify a deterministic command", {
    cwd,
    verifyCommand: {
      command: process.execPath,
      args: ["-e", "process.stdout.write('verified')"],
    },
  });

  assert.equal(result.tap.evidence.length, 2);
  assert.equal(result.tap.evidence[1]?.kind, "command");
  assert.match(result.tap.evidence[1]?.summary ?? "", /verified/);
  assert.equal(result.tap.verification.length, 1);
});

test("a verifier whose binary is missing becomes failed evidence, not a crash", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-"));
  const result = await runTask("verify with a missing binary", {
    cwd,
    verifyCommand: { command: "lattice-no-such-verifier-binary" },
  });

  assert.equal(result.status, "completed");
  const evidence = result.tap.evidence.find((item) => item.kind === "command")!;
  assert.equal(evidence.verified, false, "a command that never ran is not verified evidence");
  assert.match(evidence.summary, /exit=127/);
  assert.match(evidence.summary, /ENOENT|no such file/i);
});

test("runTask records run.failed before rethrowing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-"));
  const failing = {
    generate: async () => {
      throw new Error("generator offline");
    },
  };

  await assert.rejects(
    runTask("fail during search", {
      cwd,
      search: {
        generator: failing,
        decision: { decide: async () => { throw new Error("unused"); } },
        executor: { execute: async () => { throw new Error("unused"); } },
      },
    }),
    /generator offline/,
  );

  const [file] = await readdir(join(cwd, ".lattice", "runs"));
  const events = (await readFile(join(cwd, ".lattice", "runs", file!), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const last = events.at(-1);
  assert.equal(last.type, "run.failed");
  assert.match(last.payload.error, /generator offline/);
});

test("runTask reports each appended event to onEvent, ignoring listener errors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-"));
  const seen: string[] = [];
  const result = await runTask("observe events", {
    cwd,
    onEvent: (event) => {
      seen.push(event.type);
      if (event.type === "tap.created") throw new Error("listener bug");
    },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(seen, [
    "run.started",
    "tool.started",
    "tool.completed",
    "tap.created",
    "run.completed",
  ]);
});

test("planning grounds exact source ranges and records unverified advice without touching the target", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-plan-"));
  const latticeDir = await mkdtemp(join(tmpdir(), "lattice-plan-log-"));
  await writeFile(join(cwd, "islands.ts"), "// islands\nexport const count = 3;\n");
  let request: GeneratorRequest | undefined;
  const result = await runTask("Plan two new islands", {
    cwd, latticeDir,
    plan: { files: ["islands.ts:2-2"], generator: { generate: async (input) => {
      request = input;
      return { text: "## Plan\nExtend islands.ts:2 after reviewing save compatibility.", identity: { provider: "fixture" }, usage: { latencyMs: 0 } };
    } } },
  });
  assert.equal(request?.maxTokens, 4096);
  assert.match(request?.system ?? "", /untrusted data/);
  const source = JSON.parse(request!.context![0]!);
  assert.equal(source.content, "2: export const count = 3;");
  assert.equal(source.source, "islands.ts:2-2");
  assert.match(source.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(await readdir(cwd), ["islands.ts"]);
  assert.deepEqual(result.tap.verification, []);
  assert.equal(result.tap.evidence.at(-1)?.verified, false);
  assert.match(result.summary, /implementation and validation have not run/);
  const events = (await readFile(result.eventLogPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(events.some(event => event.payload.tool === "plan.generate" && event.payload.identity?.provider === "fixture"));
  assert.ok(!events.some(event => ["command", "experiment"].includes(event.payload.tool)));
  assert.equal(events.at(-1).type, "run.completed");
});

test("planning rejects mutation modes before any work and logs empty generator failures", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-plan-reject-"));
  const plan = { files: ["source.ts"], generator: { generate: async () => ({ text: " ", identity: { provider: "fixture" }, usage: { latencyMs: 0 } }) } };
  await assert.rejects(runTask("plan", { cwd, plan, verifyCommand: { command: "never-run" } }), /cannot run search or verification/);
  await assert.rejects(runTask("plan", { cwd, plan, search: {} as never }), /cannot run search or verification/);
  assert.deepEqual(await readdir(cwd), []);
  await writeFile(join(cwd, "source.ts"), "safe");
  await assert.rejects(runTask("plan", { cwd, plan }), /empty draft/);
  const logFile = (await readdir(join(cwd, ".lattice", "runs"))).find(name => name.endsWith(".jsonl") && !name.startsWith("._"))!;
  const events = (await readFile(join(cwd, ".lattice", "runs", logFile), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.at(-1).type, "run.failed");
  assert.ok(!events.some(event => event.type === "run.completed"));
});

test("planning source boundaries reject escapes, private files, binary data and excessive context", async () => {
  const parent = await mkdtemp(join(tmpdir(), "lattice-plan-files-"));
  const cwd = join(parent, "repo");
  await mkdir(cwd);
  await writeFile(join(parent, "outside.ts"), "outside");
  await symlink(join(parent, "outside.ts"), join(cwd, "escape.ts"));
  await writeFile(join(cwd, ".env"), "fixture only");
  await writeFile(join(cwd, "empty.ts"), "");
  await writeFile(join(cwd, "invalid.ts"), Buffer.from([0xff]));
  await writeFile(join(cwd, "binary.ts"), Buffer.from([1, 0, 2]));
  await writeFile(join(cwd, "source.ts"), "first\nsecond");
  await writeFile(join(cwd, "large.ts"), "x".repeat(100 * 1024));
  await writeFile(join(cwd, "huge.ts"), "x".repeat(513 * 1024));
  for (const [files, error] of [
    [[], /1–24/], [["source.ts"].flatMap(x => Array(25).fill(x)), /1–24/],
    [["../outside.ts"], /repository-relative/], [[join(parent, "outside.ts")], /repository-relative/],
    [["escape.ts"], /escapes repository/], [[".env"], /Private configuration/],
    [["empty.ts"], /Empty source/], [["invalid.ts"], /encoded data/],
    [["binary.ts"], /Binary/], [["source.ts:2-1"], /range/], [["source.ts:1-3"], /range/],
    [["large.ts"], /context exceeds/], [["huge.ts"], /at most/],
  ] as [string[], RegExp][]) await assert.rejects(readPlanSources(cwd, files), error);
  const before = await readPlanSources(cwd, ["source.ts:1-1"]);
  await writeFile(join(cwd, "source.ts"), "changed\nsecond");
  const after = await readPlanSources(cwd, ["source.ts:1-1"]);
  assert.notEqual(before.evidence[0]?.id, after.evidence[0]?.id);
});
