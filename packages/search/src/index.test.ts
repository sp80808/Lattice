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

test("search executes the selected candidate and stops on verified success", async () => {
  const decision: DecisionProvider = {
    async decide() {
      return {
        selected: ["repro"],
        scores: { inspect: 0.2, repro: 0.8, [UNKNOWN_CHOICE_ID]: 0 },
        confidence: 0.8,
        identity: { provider: "fixture" },
        usage: { latencyMs: 0 },
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
    onTrace: (event) => trace.push(event),
  });

  assert.equal(result.status, "solved");
  assert.equal(result.rounds, 1);
  assert.equal(executed, "repro");
  assert.deepEqual(result.selected, ["repro"]);
  assert.equal(result.tap.evidence.length, 2);
  assert.deepEqual(
    trace.map((event) => event.type),
    [
      "candidates.generated",
      "decision.completed",
      "experiment.started",
      "experiment.completed",
    ],
  );
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

  const executor: ExperimentExecutor = {
    async execute() {
      throw new Error("executor should not run");
    },
  };

  const result = await runSearchLoop({
    tap: tap(),
    generator,
    decision,
    executor,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.selected.length, 0);
  assert.match(result.tap.uncertainties.at(-1) ?? "", /could not justify/);
});
