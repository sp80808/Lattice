import assert from "node:assert/strict";
import test from "node:test";
import {
  TAP_VERSION,
  UNKNOWN_CHOICE_ID,
  type DecisionProvider,
  type EvidenceRef,
  type GeneratorProvider,
  type TapPacket,
} from "@lattice/protocol";
import {
  compileDecisionFrame,
  packEvidence,
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

function evidence(id: string, verified: boolean, summary = `summary ${id}`): EvidenceRef {
  return {
    id,
    kind: verified ? "test" : "model",
    verified,
    source: `source ${id}`,
    summary,
    createdAt: new Date(0).toISOString(),
  };
}

test("evidence packing prioritizes verified records, drops oldest unverified, and reports loss", () => {
  const records = [
    evidence("ev-old-unverified", false),
    evidence("ev-verified", true),
    evidence("ev-new-unverified", false),
  ];
  const packed = packEvidence(records, 120);
  // Verified first, then recent unverified; the oldest unverified is what drops.
  assert.deepEqual(packed.lines.map((line) => line.split(":")[0]), ["ev-verified", "ev-new-unverified"]);
  assert.deepEqual(packed.ids, ["ev-verified", "ev-new-unverified"]);
  assert.equal(packed.dropped, 1);

  // Everything fits: no loss reported, chronological order preserved.
  const roomy = packEvidence(records, 10_000);
  assert.deepEqual(roomy.ids, ["ev-old-unverified", "ev-verified", "ev-new-unverified"]);
  assert.equal(roomy.dropped, 0);

  // A single record larger than the budget is still kept: dropping everything
  // would silently make the state evidence-free.
  const huge = packEvidence([evidence("ev-huge", true, "x".repeat(500))], 100);
  assert.deepEqual(huge.ids, ["ev-huge"]);
  assert.equal(huge.dropped, 0);

  assert.deepEqual(packEvidence([], 100), { lines: [], ids: [], dropped: 0 });
});

test("decision state omits stale evidence and says so instead of silently shrinking", async () => {
  const many: EvidenceRef[] = Array.from({ length: 40 }, (_, index) =>
    evidence(`ev-${index}`, index % 4 === 0, "y".repeat(400)),
  );
  const verifiedCount = many.filter((item) => item.verified).length;
  const frame = compileDecisionFrame({ ...tap(), evidence: many }, [
    { id: "a", label: "Inspect", action: "inspect", expectedEvidence: "evidence" },
  ]);

  assert.ok(frame.evidenceIds.length < many.length, "truncation must happen");
  // Every verified record survives; only stale unverified ones are omitted.
  const verifiedIds = many.filter((item) => item.verified).map((item) => item.id);
  for (const id of verifiedIds) assert.ok(frame.evidenceIds.includes(id), `${id} must survive compaction`);
  assert.equal(verifiedCount, 10);
  assert.ok(
    frame.state.includes(`EVIDENCE_OMITTED:${many.length - frame.evidenceIds.length}`),
    frame.state.slice(0, 300),
  );
});

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

/** Providers that bill tokens/cost per call so budget logic can be exercised. */
function metered(options: { generatorTokens?: number; decisionTokens?: number; costUsd?: number } = {}) {
  const generatorTokens = options.generatorTokens ?? 100;
  const decisionTokens = options.decisionTokens ?? 50;
  const costUsd = options.costUsd ?? 0.01;
  const generatorProvider: GeneratorProvider = {
    async generate() {
      return {
        text: JSON.stringify({
          candidates: [
            { id: "inspect", label: "Inspect parser state", action: "read the parser state transition", expectedEvidence: "identify where state diverges" },
            { id: "repro", label: "Minimize failing test", action: "run a minimal reproduction", expectedEvidence: "isolate the smallest failing input" },
          ],
        }),
        identity: { provider: "metered" },
        usage: { inputTokens: generatorTokens, outputTokens: generatorTokens / 2, totalTokens: generatorTokens * 1.5, costUsd, latencyMs: 5 },
      };
    },
  };
  const decisionProvider: DecisionProvider = {
    async decide(request) {
      const id = request.choices[0]!.id;
      return {
        selected: [id],
        scores: { [id]: 0.9 },
        confidence: 0.9,
        identity: { provider: "metered" },
        usage: { inputTokens: decisionTokens, outputTokens: decisionTokens / 2, totalTokens: decisionTokens * 1.5, costUsd, latencyMs: 5 },
      };
    },
  };
  return { generator: generatorProvider, decision: decisionProvider };
}

const neverExecutor: ExperimentExecutor = {
  async execute(candidate) {
    return {
      candidateId: candidate.id,
      status: "failure",
      terminal: false,
      summary: "not solved",
      evidence: [],
    };
  },
};

test("spend accumulates from generator and decision usage and is returned", async () => {
  const { generator: gen, decision } = metered();
  const result = await runSearchLoop({
    tap: { ...tap(), budget: { maxRounds: 2 } },
    generator: gen,
    decision,
    executor: neverExecutor,
  });

  assert.equal(result.status, "budget_exhausted", "round budget runs out");
  // 2 rounds × (generator 150 + decision 75) tokens.
  assert.equal(result.spend.totalTokens, 450);
  assert.equal(result.spend.inputTokens, 300);
  assert.equal(result.spend.outputTokens, 150);
  assert.ok(Math.abs(result.spend.costUsd - 0.04) < 1e-9, `cost was ${result.spend.costUsd}`);
  assert.ok(result.spend.wallMs >= 0);
});

test("a token budget stops the loop before it is exceeded and records why", async () => {
  const { generator: gen, decision } = metered();
  const events: SearchTraceEvent[] = [];
  const result = await runSearchLoop({
    tap: { ...tap(), budget: { maxRounds: 4, maxTokens: 200 } },
    generator: gen,
    decision,
    executor: neverExecutor,
    onTrace: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.rounds, 1, "round 1 ran and hit the limit before round 2 could start");
  assert.equal(result.spend.totalTokens, 225);
  const exhausted = events.filter((event) => event.type === "budget.exhausted");
  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0]!.type === "budget.exhausted" && exhausted[0].limit, "tokens");
  assert.match(result.tap.uncertainties.at(-1) ?? "", /tokens budget exhausted/);
  // TAP budget fields are honoured without an explicit option.
  const same = await runSearchLoop({
    tap: { ...tap(), budget: { maxRounds: 4, maxTokens: 200 } },
    generator: gen,
    decision,
    executor: neverExecutor,
  });
  assert.equal(same.spend.totalTokens, 225);
});

test("a cost budget and an explicit option both gate the loop", async () => {
  const { generator: gen, decision } = metered({ costUsd: 0.5 });

  const byCost = await runSearchLoop({
    tap: { ...tap(), budget: { maxRounds: 4, maxCostUsd: 0.6 } },
    generator: gen,
    decision,
    executor: neverExecutor,
  });
  assert.equal(byCost.status, "budget_exhausted");
  assert.equal(byCost.rounds, 1, "one round costs $1.00, over the $0.60 cap");
  assert.equal(byCost.spend.costUsd, 1);

  const byOption = await runSearchLoop({
    tap: tap(),
    generator: gen,
    decision,
    executor: neverExecutor,
    budget: { maxTokens: 10 },
  });
  assert.equal(byOption.status, "budget_exhausted");
  assert.equal(byOption.rounds, 1, "the option overrides the TAP budget and stops inside round 1");
});

test("a wall-clock budget stops the loop without any token spend", async () => {
  const slowGenerator: GeneratorProvider = {
    async generate() {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        text: JSON.stringify({
          candidates: [{ id: "inspect", label: "inspect", action: "inspect", expectedEvidence: "evidence" }],
        }),
        identity: { provider: "slow" },
        usage: { latencyMs: 30 },
      };
    },
  };
  const quickDecision: DecisionProvider = {
    async decide(request) {
      return { selected: [request.choices[0]!.id], scores: {}, identity: { provider: "quick" }, usage: { latencyMs: 0 } };
    },
  };

  const result = await runSearchLoop({
    tap: { ...tap(), budget: { maxRounds: 4 } },
    generator: slowGenerator,
    decision: quickDecision,
    executor: neverExecutor,
    budget: { maxWallMs: 20 },
  });
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.rounds, 1);
  assert.equal(result.spend.totalTokens, 0);
});

test("an aborted signal stops the loop before further model calls", async () => {
  const { generator: gen, decision } = metered();
  const controller = new AbortController();
  let generatorCalls = 0;
  const countingGenerator: GeneratorProvider = {
    async generate(request) {
      generatorCalls++;
      if (generatorCalls === 2) controller.abort(new Error("user pressed escape"));
      return gen.generate(request);
    },
  };

  await assert.rejects(
    runSearchLoop({
      tap: { ...tap(), budget: { maxRounds: 5 } },
      generator: countingGenerator,
      decision,
      executor: neverExecutor,
      signal: controller.signal,
    }),
    /user pressed escape/,
  );

  // Aborting before the loop starts throws the signal's reason.
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    runSearchLoop({
      tap: tap(),
      generator: countingGenerator,
      decision,
      executor: neverExecutor,
      signal: preAborted.signal,
    }),
    /abort/i,
  );
  assert.equal(generatorCalls, 2, "no generator call happens after the pre-aborted signal");
});
