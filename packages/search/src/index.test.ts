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
  compileDecisionFrame,
  routeContextualQuestion,
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

test("contextual router asks for evidence before unsupported implementation choices", () => {
  const noEvidence = tap();
  noEvidence.evidence = [];
  const route = routeContextualQuestion(noEvidence, [
    { id: "a", label: "Change lexer", action: "edit the lexer", expectedEvidence: "build" },
    { id: "b", label: "Change parser", action: "patch parser", expectedEvidence: "tests" },
  ]);
  assert.equal(route.class, "next-action");
  assert.equal(route.reason, "missing-evidence");
  assert.match(route.question, /establishes reliable facts/i);
  assert.match(route.question, /insufficient evidence/i);
});

test("contextual router frames diagnostic experiments from live candidates", () => {
  const route = routeContextualQuestion(tap(), [
    { id: "a", label: "Inspect", action: "inspect parser state", expectedEvidence: "source line" },
    { id: "b", label: "Reproduce", action: "run minimal reproduction", expectedEvidence: "failing input" },
  ]);
  assert.equal(route.class, "experiment");
  assert.equal(route.reason, "investigation");
  assert.equal(route.mode, "choice");
  assert.match(route.question, /investigation/i);
  const frame = compileDecisionFrame(tap(), [
    { id: "a", label: "Inspect", action: "inspect parser state", expectedEvidence: "source line" },
    { id: "b", label: "Reproduce", action: "run minimal reproduction", expectedEvidence: "failing input" },
  ], route.class, route);
  assert.equal(frame.routingReason, "investigation");
  assert.equal(frame.class, "experiment");
  assert.equal(frame.mode, "choice");
  assert.ok(frame.choices.some((choice) => choice.id === UNKNOWN_CHOICE_ID));
});

test("contextual router frames verified patch selection and only ranks when topK requires it", () => {
  const candidates = [
    { id: "a", label: "Fix guard", action: "edit the guard", expectedEvidence: "tests" },
    { id: "b", label: "Fix state", action: "patch the state machine", expectedEvidence: "tests" },
  ];
  const single = routeContextualQuestion(tap(), candidates);
  const ranked = routeContextualQuestion(tap(), candidates, 2);
  assert.equal(single.class, "patch-selection");
  assert.equal(single.mode, "choice");
  assert.equal(ranked.mode, "rank");
  assert.match(single.question, /independent verification/i);
  const oneFrame = compileDecisionFrame(tap(), candidates, single.class, single);
  const rankFrame = compileDecisionFrame(tap(), candidates, ranked.class, ranked);
  assert.notEqual(oneFrame.id, rankFrame.id, "question identity includes internal provider operation");
});

test("contextual router does not promote ambiguous generated text into authority", () => {
  const route = routeContextualQuestion(tap(), [
    { id: "a", label: "Check then fix", action: "run tests and modify parser", expectedEvidence: "passing test" },
    { id: "b", label: "Investigate", action: "consider changing the parser", expectedEvidence: "diagnostic" },
  ]);
  assert.equal(route.class, "next-action");
  assert.equal(route.reason, "mixed-actions");
  assert.match(route.question, /use only the supplied evidence/i);
});

test("search passes the contextual question and internal mode to the decision provider", async () => {
  const received: Array<{ question: string; mode?: string }> = [];
  await runSearchLoop({
    tap: tap(),
    generator,
    decision: {
      async decide(request) {
        received.push({ question: request.question, mode: request.mode });
        return { selected: ["repro"], scores: { inspect: 0.3, repro: 0.7 }, identity: { provider: "fixture" }, usage: { latencyMs: 0 } };
      },
    },
    executor: {
      async execute(candidate) {
        return { candidateId: candidate.id, status: "success", terminal: true, summary: "verified", evidence: [] };
      },
    },
  });
  assert.equal(received.length, 1);
  assert.equal(received[0]!.mode, "choice");
  assert.match(received[0]!.question, /investigation/i);
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
  const rejected = trace.find((event) => event.type === "candidates.rejected");
  assert.equal(rejected?.type === "candidates.rejected" && rejected.usage?.inputTokens, 30);
});
