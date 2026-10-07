import assert from "node:assert/strict";
import test from "node:test";
import {
  TAP_VERSION,
  UNKNOWN_CHOICE_ID,
  type DecisionProvider,
  type GeneratorProvider,
  type TapPacket,
} from "@lattice/protocol";
import {
  FORMAT_ERROR_HEADER,
  REPEAT_ERROR_HEADER,
  compileDecisionFrame,
  escapeControlCharsInStrings,
  parseCandidates,
  runSearchLoop,
  type ExperimentExecutor,
  type SearchTraceEvent,
} from "./index.js";

function tap(): TapPacket {
  return {
    version: TAP_VERSION,
    runId: "run-1",
    task: "fix the failing parser test",
    objectives: ["fix the failing parser test"],
    constraints: [],
    context: [],
    hypotheses: [],
    candidateActions: [],
    evidence: [
      {
        id: "ev:1",
        kind: "test",
        verified: true,
        source: "npm test",
        summary: "parser test fails at line 12",
        createdAt: new Date(0).toISOString(),
      },
    ],
    uncertainties: [],
    verification: [],
    budget: { maxRounds: 3 },
    childRunIds: [],
  };
}

const generator: GeneratorProvider = {
  async generate() {
    return {
      text: JSON.stringify({
        candidates: [
          {
            id: "inspect",
            label: "Inspect parser state",
            action: "read the parser state transition",
            expectedEvidence: "identify where state diverges",
            estimatedCost: "low",
          },
          {
            id: "repro",
            label: "Minimize failing test",
            action: "run a minimal reproduction",
            expectedEvidence: "isolate the smallest failing input",
            estimatedCost: "low",
          },
        ],
      }),
      identity: { provider: "fixture" },
      usage: { latencyMs: 0 },
    };
  },
};

test("question compiler produces evidence-grounded neutral frame", () => {
  const frame = compileDecisionFrame(tap(), [
    {
      id: "a",
      label: "Inspect state",
      action: "inspect parser state",
      expectedEvidence: "state transition evidence",
      estimatedCost: "low",
    },
    {
      id: "b",
      label: "Reproduce failure",
      action: "run minimal reproducer",
      expectedEvidence: "smallest failing input",
      estimatedCost: "low",
    },
  ]);

  assert.equal(frame.class, "next-action");
  assert.ok(frame.evidenceIds.includes("ev:1"));
  assert.ok(frame.choices.some((choice) => choice.id === UNKNOWN_CHOICE_ID));
  assert.match(frame.question, /using only the supplied evidence/i);
  assert.equal(
    frame.audit.filter((finding) => finding.severity === "error").length,
    0,
  );
});

test("search executes the selected candidate and records rich decision trace", async () => {
  const decision: DecisionProvider = {
    async decide() {
      return {
        selected: ["repro"],
        scores: { inspect: 0.2, repro: 0.8, [UNKNOWN_CHOICE_ID]: 0 },
        confidence: 0.8,
        entropy: 0.4,
        identity: { provider: "fixture", model: "tiny" },
        usage: { latencyMs: 2, totalTokens: 11 },
      };
    },
  };

  let executed = "";
  const executor: ExperimentExecutor = {
    async execute(candidate) {
      executed = candidate.id;
      return {
        candidateId: candidate.id,
        status: "success",
        terminal: true,
        summary: "minimal reproduction confirms the fix",
        evidence: [
          {
            id: "ev:2",
            kind: "test",
            verified: true,
            source: "fixture",
            summary: "targeted test passes",
            createdAt: new Date(1).toISOString(),
          },
        ],
      };
    },
  };

  const trace: SearchTraceEvent[] = [];
  const result = await runSearchLoop({
    tap: tap(),
    generator,
    decision,
    executor,
    onTrace: (event) => { trace.push(event); },
  });

  assert.equal(result.status, "solved");
  assert.equal(executed, "repro");
  const completed = trace.find((event) => event.type === "decision.completed");
  assert.ok(completed && completed.type === "decision.completed");
  assert.equal(completed.identity.model, "tiny");
  assert.equal(completed.usage.totalTokens, 11);
  assert.ok(trace.some((event) => event.type === "decision.framed"));
});

test("manual autonomy mode requires human approval", async () => {
  const decision: DecisionProvider = {
    async decide() {
      return {
        selected: ["repro"],
        scores: { inspect: 0.2, repro: 0.8 },
        confidence: 0.8,
        identity: { provider: "fixture" },
        usage: { latencyMs: 0 },
      };
    },
  };

  let reviews = 0;
  const executor: ExperimentExecutor = {
    async execute(candidate) {
      return {
        candidateId: candidate.id,
        status: "success",
        terminal: true,
        summary: "verified",
        evidence: [],
      };
    },
  };

  const result = await runSearchLoop({
    tap: tap(),
    generator,
    decision,
    executor,
    autonomy: { mode: "manual" },
    reviewer: async () => {
      reviews += 1;
      return { action: "approve", note: "looks appropriately framed" };
    },
  });

  assert.equal(result.status, "solved");
  assert.equal(reviews, 1);
  assert.ok(result.tap.context.some((item) => item.includes("human-review")));
});

test("supervised mode blocks when review is needed but no reviewer exists", async () => {
  const decision: DecisionProvider = {
    async decide() {
      return {
        selected: ["repro"],
        scores: { inspect: 0.49, repro: 0.51 },
        confidence: 0.51,
        entropy: 0.69,
        identity: { provider: "fixture" },
        usage: { latencyMs: 0 },
      };
    },
  };

  const result = await runSearchLoop({
    tap: tap(),
    generator,
    decision,
    executor: {
      async execute() {
        throw new Error("must not execute before required review");
      },
    },
    autonomy: { mode: "supervised", minConfidence: 0.8 },
  });

  assert.equal(result.status, "blocked");
  assert.match(result.tap.uncertainties.at(-1) ?? "", /human review required/);
});

test("top-k mode ranks and executes selected candidates concurrently", async () => {
  const decision: DecisionProvider = {
    async decide() {
      return {
        selected: ["repro", "inspect"],
        scores: { repro: 0.6, inspect: 0.4 },
        confidence: 0.6,
        identity: { provider: "fixture" },
        usage: { latencyMs: 0 },
      };
    },
  };

  let active = 0;
  let maxActive = 0;
  const executor: ExperimentExecutor = {
    async execute(candidate) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      active -= 1;
      return {
        candidateId: candidate.id,
        status: candidate.id === "repro" ? "success" : "inconclusive",
        terminal: candidate.id === "repro",
        summary: candidate.id,
        evidence: [],
      };
    },
  };

  const result = await runSearchLoop({
    tap: tap(),
    generator,
    decision,
    executor,
    topK: 2,
    parallelism: 2,
  });

  assert.equal(result.status, "solved");
  assert.equal(maxActive, 2);
  assert.deepEqual(result.selected, ["repro", "inspect"]);
});

test("search blocks instead of guessing when decision selects unknown", async () => {
  const decision: DecisionProvider = {
    async decide() {
      return {
        selected: [UNKNOWN_CHOICE_ID],
        scores: {
          inspect: 0.1,
          repro: 0.1,
          [UNKNOWN_CHOICE_ID]: 0.8,
        },
        confidence: 0.8,
        identity: { provider: "fixture" },
        usage: { latencyMs: 0 },
      };
    },
  };

  const result = await runSearchLoop({
    tap: tap(),
    generator,
    decision,
    executor: {
      async execute() {
        throw new Error("executor should not run");
      },
    },
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.selected.length, 0);
});


test("verify-top runs the best-scored candidate when the decision selects none", async () => {
  const decision: DecisionProvider = {
    async decide() {
      return {
        selected: [UNKNOWN_CHOICE_ID],
        scores: { inspect: 0.1, repro: 0.3, [UNKNOWN_CHOICE_ID]: 0.6 },
        confidence: 0.6,
        identity: { provider: "fixture" },
        usage: { latencyMs: 0 },
      };
    },
  };
  let executed = "";
  const events: SearchTraceEvent[] = [];
  const result = await runSearchLoop({
    tap: tap(),
    generator,
    decision,
    onAbstain: "verify-top",
    onTrace: (event) => void events.push(event),
    executor: {
      async execute(candidate) {
        executed = candidate.id;
        return { candidateId: candidate.id, status: "success", terminal: true, summary: "verified", evidence: [] };
      },
    },
  });
  assert.equal(result.status, "solved");
  assert.equal(executed, "repro");
  assert.ok(result.tap.uncertainties.some((u) => /selected none; verifying the top-scored candidate repro/.test(u)));

  // The model's abstention stays on record; the override says who chose what ran.
  const completed = events.find((e) => e.type === "decision.completed");
  assert.deepEqual(completed?.type === "decision.completed" && completed.selected, [UNKNOWN_CHOICE_ID]);
  const overridden = events.find((e) => e.type === "decision.overridden");
  assert.ok(overridden && overridden.type === "decision.overridden");
  assert.deepEqual(
    {
      modelSelected: overridden.modelSelected,
      effectiveSelected: overridden.effectiveSelected,
      selectedBy: overridden.selectedBy,
      reason: overridden.reason,
    },
    { modelSelected: [UNKNOWN_CHOICE_ID], effectiveSelected: ["repro"], selectedBy: "abstention-policy", reason: "verify-top" },
  );
});

test("verify-top blocks instead of following candidate order when no candidate has a score", async () => {
  const decision: DecisionProvider = {
    async decide() {
      return {
        selected: [UNKNOWN_CHOICE_ID],
        scores: { [UNKNOWN_CHOICE_ID]: 1 },
        confidence: 1,
        identity: { provider: "fixture" },
        usage: { latencyMs: 0 },
      };
    },
  };
  const events: SearchTraceEvent[] = [];
  const result = await runSearchLoop({
    tap: tap(),
    generator,
    decision,
    onAbstain: "verify-top",
    onTrace: (event) => void events.push(event),
    executor: {
      async execute() {
        throw new Error("executor should not run");
      },
    },
  });
  assert.equal(result.status, "blocked");
  assert.ok(!events.some((e) => e.type === "decision.overridden"));
});

test("human reviewer can replace an insufficient-evidence decision", async () => {
  const decision: DecisionProvider = {
    async decide() {
      return {
        selected: [UNKNOWN_CHOICE_ID],
        scores: { inspect: 0.1, repro: 0.1, [UNKNOWN_CHOICE_ID]: 0.8 },
        confidence: 0.8,
        identity: { provider: "fixture" },
        usage: { latencyMs: 0 },
      };
    },
  };

  let executed = "";
  const result = await runSearchLoop({
    tap: tap(),
    generator,
    decision,
    autonomy: { mode: "manual" },
    reviewer: async () => ({
      action: "replace",
      selected: ["inspect"],
      note: "human has repository context supporting inspection",
    }),
    executor: {
      async execute(candidate) {
        executed = candidate.id;
        return {
          candidateId: candidate.id,
          status: "success",
          terminal: true,
          summary: "human override verified",
          evidence: [],
        };
      },
    },
  });

  assert.equal(result.status, "solved");
  assert.equal(executed, "inspect");
});

test("a proposal override replaces the generic prompt and trace carries generator usage", async () => {
  const requests: Array<{ system?: string; prompt: string; context?: string[] }> = [];
  const recording: GeneratorProvider = {
    async generate(request) {
      requests.push(request);
      const result = await generator.generate(request);
      return { ...result, usage: { latencyMs: 1, inputTokens: 40, outputTokens: 9 } };
    },
  };
  const decision: DecisionProvider = {
    async decide() {
      return { selected: ["repro"], scores: { repro: 1 }, identity: { provider: "fixture" }, usage: { latencyMs: 0 } };
    },
  };
  const executor: ExperimentExecutor = {
    async execute(candidate) {
      return { candidateId: candidate.id, status: "success", terminal: true, summary: "ok", evidence: [] };
    },
  };
  const trace: SearchTraceEvent[] = [];
  await runSearchLoop({
    tap: tap(),
    generator: recording,
    decision,
    executor,
    proposal: {
      system: "domain system",
      prompt: (count) => `give me ${count} files`,
      context: (packet) => [`TASK FILE for ${packet.runId}`],
    },
    onTrace: (event) => {
      trace.push(event);
    },
  });
  assert.equal(requests[0]!.system, "domain system");
  assert.equal(requests[0]!.prompt, "give me 5 files");
  assert.match(requests[0]!.context![0]!, /^OBJECTIVE:/);
  assert.equal(requests[0]!.context![1], "TASK FILE for run-1");
  const generated = trace.find((event) => event.type === "candidates.generated");
  assert.equal(generated?.type === "candidates.generated" && generated.usage?.inputTokens, 40);
});

test("an unusable generator reply is traced with its usage before the run fails", async () => {
  const trace: SearchTraceEvent[] = [];
  const broken: GeneratorProvider = {
    async generate() {
      return { text: "not json", identity: { provider: "model" }, usage: { latencyMs: 1, inputTokens: 30, outputTokens: 5 } };
    },
  };
  await assert.rejects(
    runSearchLoop({
      tap: tap(),
      generator: broken,
      decision: { decide: async () => assert.fail("decision must not run") },
      executor: { execute: async () => assert.fail("executor must not run") },
      onTrace: (event) => {
        trace.push(event);
      },
    }),
    /no JSON object/,
  );
  const rejected = trace.filter((event) => event.type === "candidates.rejected");
  assert.equal(rejected.length, 3, "the default two retries, then the run fails");
  assert.equal(rejected[0]?.type === "candidates.rejected" && rejected[0].usage?.inputTokens, 30);
  assert.deepEqual(
    rejected.map((event) => event.type === "candidates.rejected" && [event.attempt, event.retrying]),
    [[1, true], [2, true], [3, false]],
  );
});

const success: ExperimentExecutor = {
  async execute(candidate) {
    return { candidateId: candidate.id, status: "success", terminal: true, summary: "ok", evidence: [] };
  },
};
const pickFirst: DecisionProvider = {
  async decide(request) {
    const id = request.choices[0]!.id;
    return { selected: [id], scores: { [id]: 1 }, identity: { provider: "fixture" }, usage: { latencyMs: 0 } };
  },
};

test("an unusable reply's error goes back to the generator and the round continues", async () => {
  const requests: Array<{ context?: string[] }> = [];
  const replies = ["Sure! I would change the parser.", undefined];
  const flaky: GeneratorProvider = {
    async generate(request) {
      requests.push(request);
      const text = replies.shift();
      if (text !== undefined) return { text, identity: { provider: "model" }, usage: { latencyMs: 1, inputTokens: 7 } };
      return generator.generate(request);
    },
  };
  const trace: SearchTraceEvent[] = [];
  const result = await runSearchLoop({
    tap: tap(),
    generator: flaky,
    decision: pickFirst,
    executor: success,
    onTrace: (event) => {
      trace.push(event);
    },
  });
  assert.equal(result.status, "solved");
  assert.equal(result.rounds, 1, "a retry is not a new round");
  assert.equal(requests.length, 2);
  assert.ok(!requests[0]!.context!.some((block) => block.startsWith(FORMAT_ERROR_HEADER)));
  const feedback = requests[1]!.context!.find((block) => block.startsWith(FORMAT_ERROR_HEADER));
  assert.match(feedback ?? "", /no JSON object[\s\S]*Sure! I would change the parser\./);
  const rejected = trace.find((event) => event.type === "candidates.rejected");
  assert.equal(rejected?.type === "candidates.rejected" && rejected.retrying, true);
  assert.equal(rejected?.type === "candidates.rejected" && rejected.usage?.inputTokens, 7);
});

test("formatRetries 0 keeps the old fail-fast behaviour", async () => {
  let calls = 0;
  await assert.rejects(
    runSearchLoop({
      tap: tap(),
      generator: { generate: async () => (calls++, { text: "{}", identity: { provider: "model" }, usage: { latencyMs: 0 } }) },
      decision: pickFirst,
      executor: success,
      formatRetries: 0,
    }),
    /no candidates/,
  );
  assert.equal(calls, 1);
});

test("one malformed candidate is dropped without discarding its siblings", async () => {
  const text = JSON.stringify({
    candidates: [
      { id: "a", label: "missing action", expectedEvidence: "x" },
      { id: "b", label: "ok", action: "do b", expectedEvidence: "x" },
      { id: "b", label: "duplicate", action: "do b again", expectedEvidence: "x" },
      { id: "c", label: "blank", action: "   ", expectedEvidence: "x" },
    ],
  });
  const parsed = parseCandidates(text, 5);
  assert.deepEqual(parsed.candidates.map((c) => c.id), ["b"]);
  assert.equal(parsed.dropped.length, 3);
  assert.match(parsed.dropped[1]!, /duplicate id "b"/);
  assert.throws(() => parseCandidates(JSON.stringify({ candidates: [{ id: "a" }] }), 5), /no valid candidates \(candidate 1:/);

  const trace: SearchTraceEvent[] = [];
  await runSearchLoop({
    tap: tap(),
    generator: { generate: async () => ({ text, identity: { provider: "model" }, usage: { latencyMs: 0 } }) },
    decision: pickFirst,
    executor: success,
    onTrace: (event) => {
      trace.push(event);
    },
  });
  const generated = trace.find((event) => event.type === "candidates.generated");
  assert.equal(generated?.type === "candidates.generated" && generated.dropped?.length, 3);
});

test("raw newlines inside JSON strings are read as the model meant them", () => {
  const text = '```json\n{"candidates":[{"id":"a","label":"two lines","action":"line one\nline\ttwo \\"q\\"","expectedEvidence":"x"}]}\n```';
  assert.throws(() => JSON.parse(text.slice(8, -4)));
  const [candidate] = parseCandidates(text, 5).candidates;
  assert.equal(candidate!.action, 'line one\nline\ttwo "q"');
  assert.equal(escapeControlCharsInStrings('{"a":"x\ny"}\n'), '{"a":"x\\ny"}\n', "newlines outside strings are kept");
});

// ---------------------------------------------------------------------------
// Repeat detection.

const reply = (...actions: string[]) =>
  JSON.stringify({
    candidates: actions.map((action, i) => ({ id: `c${i}`, label: `try ${action}`, action, expectedEvidence: "x" })),
  });

/** Replies in order; the last one repeats forever. */
function scripted(replies: string[], requests: Array<{ context?: string[] }> = []): GeneratorProvider {
  return {
    async generate(request) {
      requests.push(request);
      const text = replies.length > 1 ? replies.shift()! : replies[0]!;
      return { text, identity: { provider: "model" }, usage: { latencyMs: 0, inputTokens: 1 } };
    },
  };
}

const failing = (ran: string[]): ExperimentExecutor => ({
  async execute(candidate) {
    ran.push(candidate.action);
    return { candidateId: candidate.id, status: "failure", terminal: false, summary: "no", evidence: [] };
  },
});

test("an action already run is dropped before the decision and counted", async () => {
  const ran: string[] = [];
  const trace: SearchTraceEvent[] = [];
  await runSearchLoop({
    tap: tap(),
    generator: scripted([reply("a"), reply("a  \r\n", "b")]),
    decision: pickFirst,
    executor: failing(ran),
    maxRounds: 2,
    onTrace: (event) => {
      trace.push(event);
    },
  });
  assert.deepEqual(ran, ["a", "b"], "round 2 runs b, not a again");
  const second = trace.filter((event) => event.type === "candidates.generated")[1];
  assert.equal(second?.type === "candidates.generated" && second.repeats, 1);
  assert.match(second?.type === "candidates.generated" ? second.dropped!.join() : "", /c0: repeats an action already tried/);
});

test("two candidates with the same action in one reply keep only the first", async () => {
  const seen: string[][] = [];
  await runSearchLoop({
    tap: tap(),
    generator: scripted([reply("a", "a", "b")]),
    decision: {
      async decide(request) {
        seen.push(request.choices.map((c) => c.id));
        return pickFirst.decide(request);
      },
    },
    executor: success,
  });
  assert.deepEqual(seen[0], ["c0", "c2"]);
});

test("a reply of repeats goes back to the generator with what it repeated", async () => {
  const ran: string[] = [];
  const requests: Array<{ context?: string[] }> = [];
  const trace: SearchTraceEvent[] = [];
  const result = await runSearchLoop({
    tap: tap(),
    generator: scripted([reply("a"), reply("a"), reply("b")], requests),
    decision: pickFirst,
    executor: failing(ran),
    maxRounds: 2,
    onTrace: (event) => {
      trace.push(event);
    },
  });
  assert.equal(result.status, "budget_exhausted");
  assert.deepEqual(ran, ["a", "b"]);
  assert.equal(requests.length, 3, "round 2 retried once");
  const feedback = requests[2]!.context!.find((block) => block.startsWith(REPEAT_ERROR_HEADER));
  assert.match(feedback ?? "", /- try a: a/);
  const rejected = trace.find((event) => event.type === "candidates.rejected");
  assert.equal(rejected?.type === "candidates.rejected" && rejected.reason, "repeat");
});

test("a generator that only repeats itself stops the run as stuck instead of failing", async () => {
  const ran: string[] = [];
  const result = await runSearchLoop({
    tap: tap(),
    generator: scripted([reply("a")]),
    decision: pickFirst,
    executor: failing(ran),
    maxRounds: 5,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.rounds, 2);
  assert.deepEqual(ran, ["a"], "the known failure is not re-run");
  assert.match(result.tap.uncertainties.join(), /stuck/);
});

test("actionKey decides what counts as the same action", async () => {
  const ran: string[] = [];
  await runSearchLoop({
    tap: tap(),
    generator: scripted([reply("a+b"), reply("a + b", "b+a")]),
    decision: pickFirst,
    executor: failing(ran),
    maxRounds: 2,
    actionKey: (candidate) => candidate.action.replace(/\s+/g, ""),
  });
  assert.deepEqual(ran, ["a+b", "b+a"]);
});

test("allowRepeats keeps the behaviour from before repeat detection", async () => {
  const ran: string[] = [];
  const result = await runSearchLoop({
    tap: tap(),
    generator: scripted([reply("a")]),
    decision: pickFirst,
    executor: failing(ran),
    maxRounds: 3,
    allowRepeats: true,
  });
  assert.equal(result.status, "budget_exhausted");
  assert.deepEqual(ran, ["a", "a", "a"]);
});
