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
  const rejected = trace.find((event) => event.type === "candidates.rejected");
  assert.equal(rejected?.type === "candidates.rejected" && rejected.usage?.inputTokens, 30);
});

test("top-k [A,B], A executor throws, B verified-success => run solves via B", async () => {
  const decision: DecisionProvider = {
    async decide() {
      return {
        selected: ["inspect", "repro"],
        scores: { inspect: 0.6, repro: 0.4 },
        confidence: 0.6,
        identity: { provider: "fixture" },
        usage: { latencyMs: 0 },
      };
    },
  };

  const trace: SearchTraceEvent[] = [];
  const result = await runSearchLoop({
    tap: tap(),
    generator,
    decision,
    topK: 2,
    parallelism: 2,
    onTrace: (event) => void trace.push(event),
    executor: {
      async execute(candidate) {
        if (candidate.id === "inspect") {
          throw new Error("tool crashed during inspect");
        }
        return {
          candidateId: candidate.id,
          status: "success",
          terminal: true,
          summary: "verified fix",
          evidence: [],
        };
      },
    },
  });

  assert.equal(result.status, "solved");
  const failed = trace.find((e) => e.type === "experiment.failed");
  assert.ok(failed && failed.type === "experiment.failed");
  assert.equal(failed.candidateId, "inspect");
  assert.equal(failed.errorClass, "tool_error");
});

test("A throws, B ordinary failure => round retains both states and continues", async () => {
  const decision: DecisionProvider = {
    async decide() {
      return {
        selected: ["inspect", "repro"],
        scores: { inspect: 0.6, repro: 0.4 },
        confidence: 0.6,
        identity: { provider: "fixture" },
        usage: { latencyMs: 0 },
      };
    },
  };

  const result = await runSearchLoop({
    tap: tap(),
    generator,
    decision,
    topK: 2,
    parallelism: 2,
    executor: {
      async execute(candidate) {
        if (candidate.id === "inspect") {
          throw new Error("tool timeout");
        }
        return {
          candidateId: candidate.id,
          status: "failure",
          terminal: false,
          summary: "hypothesis disproved",
          evidence: [],
        };
      },
    },
  });

  // Since neither solved, budget is exhausted (run out of rounds since both just return/fail)
  assert.equal(result.status, "budget_exhausted");
  const ctx = result.tap.context.join("\\n");
  assert.match(ctx, /r1:inconclusive:Tool error: tool timeout/);
  assert.match(ctx, /r1:failure:hypothesis disproved/);
});

test("candidate ID mismatch => still aborts as invariant violation", async () => {
  const decision: DecisionProvider = {
    async decide() {
      return {
        selected: ["inspect"],
        scores: { inspect: 1 },
        confidence: 1,
        identity: { provider: "fixture" },
        usage: { latencyMs: 0 },
      };
    },
  };

  await assert.rejects(
    runSearchLoop({
      tap: tap(),
      generator,
      decision,
      executor: {
        async execute() {
          return {
            candidateId: "wrong-id",
            status: "success",
            terminal: true,
            summary: "",
            evidence: [],
          };
        },
      },
    }),
    /Experiment outcome candidate mismatch/,
  );
});

test("two siblings throw independently => deterministic two-failure trace", async () => {
  const decision: DecisionProvider = {
    async decide() {
      return {
        selected: ["inspect", "repro"],
        scores: { inspect: 0.6, repro: 0.4 },
        confidence: 0.6,
        identity: { provider: "fixture" },
        usage: { latencyMs: 0 },
      };
    },
  };

  const testTap = tap();
  testTap.budget.maxRounds = 1;

  const trace: SearchTraceEvent[] = [];
  const result = await runSearchLoop({
    tap: testTap,
    generator,
    decision,
    topK: 2,
    parallelism: 2,
    onTrace: (event) => void trace.push(event),
    executor: {
      async execute(candidate) {
        throw new Error(`crash ${candidate.id}`);
      },
    },
  });

  assert.equal(result.status, "budget_exhausted");
  const failures = trace.filter((e) => e.type === "experiment.failed");
  assert.equal(failures.length, 2);
  assert.equal((failures[0] as any).candidateId, "inspect");
  assert.equal((failures[1] as any).candidateId, "repro");
});

test("siblings complete out of order => output/evidence order remains deterministic", async () => {
  const decision: DecisionProvider = {
    async decide() {
      return {
        selected: ["inspect", "repro"],
        scores: { inspect: 0.6, repro: 0.4 },
        confidence: 0.6,
        identity: { provider: "fixture" },
        usage: { latencyMs: 0 },
      };
    },
  };

  const result = await runSearchLoop({
    tap: tap(),
    generator,
    decision,
    topK: 2,
    parallelism: 2,
    executor: {
      async execute(candidate) {
        if (candidate.id === "inspect") {
          await new Promise((r) => setTimeout(r, 20));
          throw new Error("inspect timeout");
        }
        return {
          candidateId: candidate.id,
          status: "failure",
          terminal: false,
          summary: "repro failure",
          evidence: [],
        };
      },
    },
  });

  // Outcomes array is accessed by index, so context pushes are in order of candidate selection (inspect, then repro)
  const contextRows = result.tap.context.filter(r => r.startsWith("r1:"));
  assert.equal(contextRows.length, 2);
  assert.match(contextRows[0]!, /inconclusive:Tool error: inspect timeout/);
  assert.match(contextRows[1]!, /failure:repro failure/);
});

test("known usage incurred before exception remains charged", async () => {
  const decision: DecisionProvider = {
    async decide() {
      return {
        selected: ["inspect"],
        scores: { inspect: 1 },
        confidence: 1,
        identity: { provider: "fixture" },
        usage: { latencyMs: 0 },
      };
    },
  };

  const trace: SearchTraceEvent[] = [];
  const result = await runSearchLoop({
    tap: tap(),
    generator,
    decision,
    onTrace: (event) => void trace.push(event),
    executor: {
      async execute(candidate) {
        const err = new Error("failed after partial execution");
        (err as any).evidence = [
          { id: "partial-ev:1", kind: "test", verified: false, source: "executor", summary: "we tried", createdAt: new Date().toISOString() },
        ];
        throw err;
      },
    },
  });

  assert.equal(result.status, "budget_exhausted");
  const failedEvent = trace.find((e) => e.type === "experiment.failed");
  assert.ok(failedEvent && failedEvent.type === "experiment.failed");
  assert.equal(failedEvent.evidence?.length, 1);
  assert.equal(failedEvent.evidence?.[0]?.id, "partial-ev:1");
  assert.ok(result.tap.evidence.some(e => e.id === "partial-ev:1"));
});
