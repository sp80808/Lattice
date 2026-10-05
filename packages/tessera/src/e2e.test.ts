import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runTask } from "@lattice/core";
import {
  createWitnessVerifier,
  loadRepairTask,
  randomArm,
  replayRunLog,
  runRepair,
  runWitness,
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const tasks = join(here, "..", "..", "..", "examples", "tessera-repair", "tasks");

// ---------------------------------------------------------------------------
// End to end against a real `tsr` binary. CI's tessera-witness job builds
// Tessera and sets TSR; without it this file fails rather than skipping or
// faking a compiler result. It is not part of `npm test`.

if (!process.env.TSR) {
  throw new Error("set TSR to a tsr binary (cargo build --release -p tessera-cli in Tessera)");
}

test("tsr witness: pass, fail and unsupported come from the real compiler", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lattice-tsr-"));
  const ok = join(dir, "ok.tes");
  const bad = join(dir, "bad.tes");
  await writeFile(ok, "f add(a:i64,b:i64)>i64=a+b\n");
  await writeFile(bad, "f add(a:i64,b:i64)>i64=a+\n");

  const pass = await runWitness(ok);
  assert.equal(pass.verdict.outcome, "pass", pass.verdict.reason);
  assert.equal(pass.exitCode, 0);
  assert.match(pass.document!.tool.commit, /^[0-9a-f]{40}$|^unknown$/);

  const fail = await runWitness(bad);
  assert.equal(fail.verdict.outcome, "fail");
  assert.equal(fail.document!.diagnostics[0]!.code, "E-syntax-expected");

  const unsupported = await runWitness(ok, { phase: "backend" });
  assert.equal(unsupported.verdict.outcome, "unsupported");
  assert.equal(unsupported.exitCode, 3);

  const missing = await runWitness(join(dir, "missing.tes"));
  assert.equal(missing.verdict.outcome, "tool_error");
  assert.equal(missing.verdict.verified, false);

  const again = await runWitness(ok);
  assert.equal(again.document!.result_id, pass.document!.result_id, "repeat runs are deterministic");
});

test("runTask stores the witness record and replays it without tsr", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lattice-tsr-run-"));
  await writeFile(join(dir, "add.tes"), "f add(a:i64,b:i64)>i64=a+b+1\n");
  const result = await runTask("check add", {
    cwd: dir,
    verifier: createWitnessVerifier({
      file: "add.tes",
      overflow: "trapping",
      cases: [{ function: "add", args: [2, 3], expect: "5" }],
    }),
  });
  const build = result.tap.evidence.find((e) => e.kind === "build")!;
  const run = result.tap.evidence.find((e) => e.kind === "test")!;
  assert.match(build.summary, /tsr_witness=pass/);
  assert.match(run.summary, /add\(2,3\)=6 expected 5/);
  assert.ok(result.tap.verification.includes(build.id));

  const replayed = await replayRunLog(result.eventLogPath);
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0]!.replayedOutcome, "pass");
  assert.equal(replayed[0]!.consistent, true);
  assert.equal(replayed[0]!.passed, false, "behavioural case failed");
});

test("repair loop: tsr decides, random baseline runs the same tasks", async () => {
  const task = await loadRepairTask(join(tasks, "syntax-error"));
  const report = await runRepair({ task, seed: 1, maxRounds: 8 });
  assert.equal(report.status, "solved", report.error);
  assert.match(report.patch!, /^f add\(a:i64,b:i64\)>i64=(a\+b|b\+a)\n$/);
  assert.equal(report.tokens, 0, "offline stubs spend no tokens");
  assert.ok(report.initialResultId?.startsWith("sha256:"));

  const replayed = await replayRunLog(report.eventLogPath);
  assert.ok(replayed.every((r) => r.consistent));
  assert.equal(replayed.at(-1)!.passed, true);
  assert.equal(replayed.filter((r) => r.passed).length, 1, "only the accepted candidate passed");

  const arm = randomArm();
  const original = await readFile(join(task.dir, task.file), "utf8");
  const random = await runRepair({ task, seed: 1, maxRounds: 8, arm: arm.name, decision: arm.decision(1, original) });
  assert.equal(random.arm, "random");
  assert.ok(["solved", "budget_exhausted", "blocked"].includes(random.status));
});

test("tsr's checked suggestion repairs Rust-style TC without the generator", async () => {
  const task = await loadRepairTask(join(tasks, "foreign-syntax"));
  let generatorCalls = 0;
  const generator = {
    async generate() {
      generatorCalls++;
      return { text: "{}", identity: { provider: "model" }, usage: { latencyMs: 1, totalTokens: 100 } };
    },
  };
  const report = await runRepair({ task, seed: 1, generator });
  assert.equal(report.status, "solved", report.error);
  assert.equal(report.patch, "f add(a:i64,b:i64)>i64=a+b\n");
  assert.equal(report.solvedBySuggestion, true);
  assert.equal(generatorCalls, 0, "no model call was needed");
  assert.equal(report.tokens, 0);

  const without = await runRepair({ task, seed: 1, suggestions: false, maxRounds: 2 });
  assert.notEqual(without.status, "solved", "the mutation stub cannot read Rust syntax");
});

test("unbound names: tsr offers each closest parameter and the cases pick one", async () => {
  const task = await loadRepairTask(join(tasks, "unbound-name"));
  const report = await runRepair({ task, seed: 1 });
  assert.equal(report.status, "solved", report.error);
  assert.equal(report.patch, "f add(a:i64,b:i64)>i64=a+b\n");
  assert.equal(report.solvedBySuggestion, true);
});
