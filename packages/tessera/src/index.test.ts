import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runTask } from "@lattice/core";
import {
  HeuristicRepairDecider,
  MutationRepairGenerator,
  TRIED_HEADER,
  classifyWitness,
  computeResultId,
  createWitnessVerifier,
  loadRepairTask,
  mutationBodies,
  parseTcFunction,
  parseWitness,
  randomArm,
  replayRunLog,
  replayVerification,
  runRepair,
  runWitness,
  summarize,
  verificationEvidence,
  type RepairRunReport,
  type TesseraVerificationRecord,
  type WitnessDocument,
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");
const tasks = join(here, "..", "..", "..", "examples", "tessera-repair", "tasks");

// Documents recorded from a real `tsr witness` (Tessera e941def) and the exit
// code it returned. The end-to-end tests below run the binary itself.
const RECORDED: Array<[string, number, string]> = [
  ["pass", 0, "pass"],
  ["pass_mir", 0, "pass"],
  ["syntax_error", 1, "fail"],
  ["semantic_error", 1, "fail"],
  ["unsupported", 3, "unsupported"],
  ["tool_error", 4, "tool_error"],
];

async function recorded(name: string): Promise<WitnessDocument> {
  return parseWitness(await readFile(join(fixtures, `${name}.json`), "utf8"));
}

test("recorded witness documents classify by outcome and exit code", async () => {
  for (const [name, exit, outcome] of RECORDED) {
    const document = await recorded(name);
    assert.equal(computeResultId(document), document.result_id, `${name} result_id`);
    const verdict = classifyWitness(document, exit);
    assert.equal(verdict.outcome, outcome, name);
    assert.equal(verdict.verified, outcome !== "tool_error", name);
  }
});

test("an exit code that disagrees with the outcome is not trusted", async () => {
  const verdict = classifyWitness(await recorded("syntax_error"), 0);
  assert.equal(verdict.outcome, "tool_error");
  assert.equal(verdict.verified, false);
  assert.match(verdict.reason ?? "", /disagrees with exit code 0/);
});

test("a tampered document fails result_id and is not trusted", async () => {
  const document = await recorded("syntax_error");
  document.outcome = "pass";
  document.diagnostics = [];
  const verdict = classifyWitness(document, 0);
  assert.equal(verdict.outcome, "tool_error");
  assert.match(verdict.reason ?? "", /result_id mismatch/);
});

test("result_id ignores timing and path only", async () => {
  const document = await recorded("pass");
  const moved = structuredClone(document);
  moved.invocation.path = "/elsewhere/pass.tes";
  moved.timing = { compile_us: 1, total_us: 2 };
  assert.equal(computeResultId(moved), document.result_id);
  moved.invocation.phase = "mir";
  assert.notEqual(computeResultId(moved), document.result_id);
});

test("parseWitness rejects other schemas and non-JSON", () => {
  assert.throws(() => parseWitness("ok: 1 function(s) checked"), /not JSON/);
  assert.throws(() => parseWitness('{"schema":"tessera.witness/v9"}'), /unsupported witness schema/);
});

function record(document: WitnessDocument, exitCode: number): TesseraVerificationRecord {
  return {
    schema: "lattice.tessera-verification/v0",
    file: "add.tes",
    witness: {
      command: "tsr",
      args: ["witness", "add.tes"],
      exitCode,
      verdict: classifyWitness(document, exitCode),
      document,
      durationMs: 1,
    },
    cases: [],
  };
}

test("evidence carries tool identity, result_id and diagnostics", async () => {
  const [build] = verificationEvidence(record(await recorded("semantic_error"), 1));
  assert.equal(build!.kind, "build");
  assert.equal(build!.verified, true);
  assert.match(build!.summary, /tsr_witness=fail/);
  assert.match(build!.summary, /tsr=0\.0\.1@e941def661ca/);
  assert.match(build!.summary, /E-resolve-unbound-name 1:20 unbound variable `b`/);
});

test("replay re-derives the verdict from the stored document", async () => {
  const stored = record(await recorded("pass"), 0);
  assert.deepEqual(
    { ...replayVerification(stored), resultId: undefined },
    { file: "add.tes", storedOutcome: "pass", replayedOutcome: "pass", resultId: undefined, passed: true, consistent: true, reason: undefined },
  );
  const edited = structuredClone(stored);
  edited.witness.document!.outcome = "fail";
  const replayed = replayVerification(edited);
  assert.equal(replayed.consistent, false);
  assert.equal(replayed.passed, false);
});

test("mutation generator proposes untried edits in a seeded order", async () => {
  const source = "f add(a:i64,b:i64)>i64=a+c\n";
  const fn = parseTcFunction(source)!;
  assert.deepEqual(fn.params, ["a", "b"]);
  assert.ok(mutationBodies(fn).includes("a+b"));
  assert.ok(!mutationBodies(fn).includes("a+c"));

  const ids = async (seed: number, context: string[] = []) =>
    JSON.parse(
      (await new MutationRepairGenerator(source, seed).generate({ prompt: "up to 3", context })).text,
    ).candidates.map((c: { action: string }) => c.action.trim());
  assert.deepEqual(await ids(4), await ids(4));
  const first = await ids(4);
  assert.equal(first.length, 3);
  const after = await ids(4, [`${TRIED_HEADER}\n${first[0]}`]);
  assert.ok(!after.includes(first[0]));
});

test("heuristic decider avoids names tsr reported unbound", async () => {
  const decider = new HeuristicRepairDecider("f add(a:i64,b:i64)>i64=a+c\n");
  const choice = (id: string, body: string) => ({
    id,
    label: id,
    detail: `action: f add(a:i64,b:i64)>i64=${body}\n | expected evidence: pass`,
  });
  const result = await decider.decide({
    state: "EVIDENCE:\nev:1:build:verified:diagnostics: resolve E-resolve-unbound-name 1:26 unbound variable `c` (not a parameter of `add`)",
    question: "which?",
    choices: [choice("keep", "a+c+c"), choice("fix", "a+b")],
  });
  assert.deepEqual(result.selected, ["fix"]);
});

test("summaries report cost per verified patch", () => {
  const run = (arm: string, status: RepairRunReport["status"], rounds: number, cost: number): RepairRunReport => ({
    task: "t", arm, seed: 1, status, rounds, verifications: rounds, tsrProcesses: rounds, cacheHits: 0,
    generator: { calls: rounds, inputTokens: 0, outputTokens: 0, totalTokens: 100 * rounds, costUsd: cost },
    decision: { calls: rounds, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    tokens: 100 * rounds, costUsd: cost, runId: "r", eventLogPath: "",
  });
  const [a, b] = summarize([run("model", "solved", 1, 0.01), run("model", "budget_exhausted", 6, 0.05), run("random", "solved", 3, 0.03)]);
  assert.equal(a!.solved, 1);
  assert.ok(Math.abs(a!.costPerVerifiedPatchUsd! - 0.06) < 1e-12);
  assert.equal(a!.tokensPerVerifiedPatch, 700);
  assert.equal(b!.meanRoundsToSolve, 3);
});

// ---------------------------------------------------------------------------
// End to end against a real `tsr` binary. CI builds Tessera and sets TSR;
// without it these are skipped rather than faked.

const tsr = process.env.TSR;
const e2e = { skip: tsr ? false : "set TSR to a tsr binary to run the witness end-to-end tests" };

test("tsr witness: pass, fail and unsupported come from the real compiler", e2e, async () => {
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

test("runTask stores the witness record and replays it without tsr", e2e, async () => {
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

test("repair loop: tsr decides, random baseline runs the same tasks", e2e, async () => {
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
