import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  HeuristicRepairDecider,
  MutationRepairGenerator,
  RecordedRounds,
  TRIED_HEADER,
  classifyWitness,
  computeResultId,
  loadRepairTask,
  mutationBodies,
  parseTcFunction,
  parseWitness,
  repairProposal,
  replayVerification,
  summarize,
  verificationEvidence,
  type RepairRunReport,
  type TesseraVerificationRecord,
  type WitnessDocument,
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");

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

test("replay recomputes case results instead of trusting the stored flag", async () => {
  const stored = record(await recorded("pass"), 0);
  stored.cases = [{ function: "add", args: ["2", "3"], expect: "5", actual: "6", exitCode: 0, passed: true }];
  const replayed = replayVerification(stored);
  assert.equal(replayed.passed, false);
  assert.equal(replayed.consistent, false);
  assert.match(replayed.reason ?? "", /stored passed=true but printed "6"/);
});

test("repair tasks cannot point outside their directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lattice-task-"));
  await writeFile(
    join(dir, "task.json"),
    JSON.stringify({ file: "../../etc/target.tes", overflow: "trapping", cases: [{ function: "f", args: [], expect: "1" }] }),
  );
  await assert.rejects(loadRepairTask(dir), /inside the task directory/);
});

test("arms sharing a generator see the same recorded rounds", async () => {
  let calls = 0;
  const live = {
    async generate() {
      calls++;
      return { text: `round-${calls}`, identity: { provider: "model" }, usage: { latencyMs: 1, totalTokens: 10 } };
    },
  };
  const rounds = new RecordedRounds();
  const first = rounds.wrap("task/1", live);
  const second = rounds.wrap("task/1", live);
  const other = rounds.wrap("task/2", live);
  assert.equal((await first.generate({ prompt: "p" })).text, "round-1");
  assert.equal((await first.generate({ prompt: "p" })).text, "round-2");
  assert.equal((await second.generate({ prompt: "p" })).text, "round-1");
  assert.equal((await second.generate({ prompt: "p" })).usage.totalTokens, 10, "replayed rounds keep their cost");
  assert.equal((await second.generate({ prompt: "p" })).text, "round-3", "beyond the recording it calls the model");
  assert.equal((await other.generate({ prompt: "p" })).text, "round-4");
  assert.equal(calls, 4);
});

test("the repair prompt shows a valid program and rules out C-style bodies", () => {
  const prompt = repairProposal(
    { name: "t", dir: ".", description: "", file: "add.tes", overflow: "trapping", cases: [] },
    async () => "",
  );
  assert.match(prompt.system ?? "", /`f twice\(x:i64\)>i64=x\+x`/);
  assert.match(prompt.system ?? "", /no braces, `return`, semicolons/);
});
