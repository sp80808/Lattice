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
