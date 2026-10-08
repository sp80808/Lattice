import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  HeuristicRepairDecider,
  MutationRepairGenerator,
  ATTEMPTS_HEADER,
  RecordedRounds,
  SuggestionFirstGenerator,
  TRIED_HEADER,
  classifyWitness,
  computeResultId,
  loadRepairTask,
  runRepair,
  mutationBodies,
  parseTcFunction,
  parseWitness,
  renderAttempts,
  renderDiagnostics,
  renderVerdict,
  repairProposal,
  replayVerification,
  summarize,
  verificationEvidence,
  runWitness,
  witnessSuggestions,
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
  // Tessera 2e3dac2: help, fixes and suggestions.
  ["foreign_syntax", 1, "fail"],
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
    tokens: 100 * rounds, costUsd: cost, runId: "r", eventLogPath: "", suggestionRounds: 0,
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

// ---------------------------------------------------------------------------
// Feedback shown to the repair model, and tsr's own suggestions.

const RUST_STYLE = "fn add(a: i64, b: i64) -> i64 {\n    return a + b;\n}\n";

test("diagnostics render like a compiler: caret, help, cascades counted", async () => {
  const document = await recorded("foreign_syntax");
  const text = renderDiagnostics(RUST_STYLE, document.diagnostics);
  const lines = text.split("\n");
  assert.match(lines[0]!, /^error\[E-syntax-foreign\] 1:1: this is not TC syntax: functions start with `f`, not `fn`/);
  assert.equal(lines[1], "  | fn add(a: i64, b: i64) -> i64 {");
  assert.equal(lines[2], "  | ^^");
  assert.match(lines[3]!, /^  help: a TC program is one function: `f NAME\(P:i64,...\)>i64=EXPR`$/);
  assert.match(lines.at(-1)!, /^\(\d+ more, likely follow-on errors\)$/);
  assert.ok(lines.length < 16, "capped, not eleven cascades");
  // Documents from a tsr without `help` still render.
  const older = renderDiagnostics("f add(a:i64)>i64=a+b\n", (await recorded("semantic_error")).diagnostics);
  assert.ok(older.endsWith("\n  | f add(a:i64)>i64=a+b\n  | " + " ".repeat(19) + "^"), older);
});

test("each rejected attempt carries its own verdict", async () => {
  const foreign = record(await recorded("foreign_syntax"), 1);
  const wrong = record(await recorded("pass"), 0);
  wrong.cases = [{ function: "add", args: ["2", "3"], expect: "5", actual: "6", exitCode: 0, passed: false }];
  assert.match(renderVerdict("f add(a:i64,b:i64)>i64=a+b+1\n", wrong), /add\(2, 3\) returned 6, expected 5/);
  const attempts = [
    { source: RUST_STYLE, record: foreign },
    { source: "f add(a:i64,b:i64)>i64=a+b+1\n", record: wrong },
  ];
  const text = renderAttempts(attempts)!;
  assert.ok(text.startsWith(ATTEMPTS_HEADER));
  assert.ok(text.indexOf("E-syntax-foreign") < text.indexOf("returned 6"), "in order, paired with its source");
  assert.equal(renderAttempts([]), undefined);
  assert.match(renderAttempts([...attempts, ...attempts], 2)!, /2 earlier attempts omitted/);
});

test("the prompt carries the grammar, the current verdict and paired attempts", async () => {
  const task = { name: "t", dir: ".", description: "", file: "add.tes", overflow: "trapping" as const, cases: [] };
  const foreign = record(await recorded("foreign_syntax"), 1);
  const prompt = repairProposal(task, async () => RUST_STYLE, () => [RUST_STYLE], {
    grammar: "program = function ;",
    current: () => foreign,
    attempts: () => [{ source: RUST_STYLE, record: foreign }],
  });
  const context = await prompt.context!({} as never);
  assert.equal(context[0], "TC GRAMMAR (from tsr grammar; the only accepted syntax):\nprogram = function ;");
  assert.ok(context.some((block) => block.startsWith("TSR ON CURRENT add.tes:\nerror[E-syntax-foreign]")));
  assert.ok(context.some((block) => block.startsWith(ATTEMPTS_HEADER)));
  assert.ok(context.at(-1)!.startsWith(TRIED_HEADER), "the tried list stays last for the mutation stub");
  const bare = await repairProposal(task, async () => "x").context!({} as never);
  assert.deepEqual(bare, ["CURRENT add.tes:\nx"], "without feedback the prompt is unchanged");
});

test("tsr suggestions are offered once, for free, before the generator", async () => {
  assert.deepEqual(witnessSuggestions(await recorded("foreign_syntax")), [
    { source: "f add(a:i64,b:i64)>i64=a+b\n", label: "rewrite in TC syntax" },
  ]);
  assert.deepEqual(witnessSuggestions(await recorded("semantic_error")), [], "older tsr: none");

  let modelCalls = 0;
  const model = {
    async generate() {
      modelCalls++;
      return { text: "{}", identity: { provider: "model" }, usage: { latencyMs: 1, totalTokens: 50 } };
    },
  };
  const pool = [
    { source: "f add(a:i64,b:i64)>i64=a+a\n", label: "use parameter `a`" },
    { source: "f add(a:i64,b:i64)>i64=a+b\n", label: "use parameter `b`" },
  ];
  const tried = ["f add(a:i64,b:i64)>i64=a+a\n"];
  const generator = new SuggestionFirstGenerator(model, () => pool, () => tried);
  const first = await generator.generate({ prompt: "Propose up to 4 distinct candidate repairs" });
  const { candidates } = JSON.parse(first.text) as { candidates: Array<{ id: string; action: string }> };
  assert.deepEqual(candidates.map((c) => c.action), ["f add(a:i64,b:i64)>i64=a+b\n"], "tried ones are skipped");
  assert.match(candidates[0]!.id, /^tsr-[0-9a-f]{8}$/);
  assert.equal(first.usage.totalTokens, 0);
  assert.equal(first.identity.provider, "tsr");
  const again = await generator.generate({ prompt: "Propose up to 4" });
  assert.equal(again.identity.provider, "tsr", "not verified yet (the decider chose another), so offered again");
  await generator.generate({ prompt: "Propose up to 4" });
  assert.equal(modelCalls, 1, "after two offers the generator is asked");
});

test("summaries keep compiler repairs apart from model results", () => {
  const usage = (tokens: number, cost: number) => ({ calls: 1, inputTokens: 0, outputTokens: 0, totalTokens: tokens, costUsd: cost });
  const run = (
    status: RepairRunReport["status"],
    source: "compiler_suggestion" | "model_generator" | undefined,
    tokens: number,
    cost: number,
  ): RepairRunReport => ({
    task: "t", arm: "a", seed: 1, status, rounds: 1, verifications: 1, tsrProcesses: 1, cacheHits: 0,
    generator: usage(tokens, cost), decision: usage(0, 0), tokens, costUsd: cost,
    runId: "r", eventLogPath: "", suggestionRounds: source === "compiler_suggestion" ? 1 : 0,
    lineage: source && { candidateId: "c", candidateSource: source, selectionSource: "model_decision" },
  });
  const [s] = summarize([
    run("solved", "compiler_suggestion", 0, 0),
    run("solved", "compiler_suggestion", 40, 0.004), // a model decider still spent tokens
    run("solved", "model_generator", 300, 0.03),
    run("budget_exhausted", undefined, 500, 0.05),
  ]);
  assert.deepEqual(
    [s!.solved, s!.solvedByCompilerRepair, s!.solvedByModelGenerator, s!.unresolved],
    [3, 2, 1, 1],
  );
  assert.equal(s!.modelTokensPerModelPatch, 800, "model spend over model-generated patches only");
  assert.ok(Math.abs(s!.modelCostPerModelPatchUsd! - 0.08) < 1e-12);
  assert.equal(s!.tokensPerVerifiedPatch, 280, "end-to-end includes compiler repairs");
  const [none] = summarize([run("solved", "compiler_suggestion", 0, 0)]);
  assert.equal(none!.modelTokensPerModelPatch, null, "no model patch, no model efficiency");
});

test("a candidate verified by the abstention fallback is a policy selection", async () => {
  const task = await loadRepairTask(join(here, "..", "..", "..", "examples", "tessera-repair", "tasks", "wrong-result"));
  // A model decider that ranks the candidates but selects none.
  const abstainer = {
    async decide(request: { choices: Array<{ id: string }> }) {
      return {
        selected: [] as string[],
        scores: Object.fromEntries(request.choices.map((c, i) => [c.id, 1 / (i + 1)])),
        identity: { provider: "model", model: "abstains" },
        usage: { latencyMs: 1, totalTokens: 5 },
      };
    },
  };
  const report = await runRepair({ task, seed: 1, maxRounds: 1, decision: abstainer as never, suggestions: false, grammar: false, tsr: "/nonexistent/tsr" });
  const log = (await readFile(report.eventLogPath, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const lineages = log
    .filter((e) => e.type === "tool.completed" && e.payload?.tool === "experiment")
    .flatMap((e) => e.payload.outcome?.records ?? [])
    .map((r: { lineage?: unknown }) => r.lineage);
  assert.ok(lineages.length > 0, "the fallback verified a candidate");
  for (const lineage of lineages) {
    assert.equal((lineage as { selectionSource: string }).selectionSource, "deterministic_policy");
  }
});

test("witness process timeout becomes unverified tool_error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lattice-witness-timeout-"));
  const fakeTsr = join(dir, "fake-tsr");
  const source = join(dir, "ok.tes");
  await writeFile(source, "f add(a:i64,b:i64)>i64=a+b\n");
  await writeFile(fakeTsr, "#!/bin/bash\nsleep 30\n");
  await chmod(fakeTsr, 0o755);

  const started = performance.now();
  const run = await runWitness(source, { tsr: fakeTsr, timeoutMs: 200 });
  assert.equal(run.verdict.outcome, "tool_error");
  assert.equal(run.verdict.verified, false);
  assert.match(run.verdict.reason ?? "", /timed out/);
  assert.ok(performance.now() - started < 5_000, "timeout path must not wait out the fake sleep");
});
