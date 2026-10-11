import assert from "node:assert/strict";
import test from "node:test";
import type { DecisionProvider, DecisionRequest, DecisionResult } from "@lattice/protocol";
import {
  computeDecisionFrameId,
  MemoizedDecisionProvider,
} from "./memoize.js";

function mockProvider(responses: DecisionResult[]): DecisionProvider & { calls: number } {
  let callCount = 0;
  return {
    get calls() {
      return callCount;
    },
    async decide(_req: DecisionRequest): Promise<DecisionResult> {
      const resp = responses[callCount] ?? responses[responses.length - 1]!;
      callCount += 1;
      return resp;
    },
  };
}

const SAMPLE_REQUEST: DecisionRequest = {
  question: "Select the next engineering action",
  state: "Failing test in parser: expected token 'foo', got 'bar'",
  choices: [
    { id: "inspect", label: "Inspect evidence" },
    { id: "edit", label: "Edit parser" },
    { id: "run_tests", label: "Run test suite" },
  ],
};

const SAMPLE_RESULT: DecisionResult = {
  selected: ["inspect"],
  scores: { inspect: 0.8, edit: 0.15, run_tests: 0.05 },
  confidence: 0.8,
  identity: { provider: "test-model", model: "tev1:0.8b" },
  usage: { latencyMs: 450, totalTokens: 120 },
};

test("computeDecisionFrameId is deterministic and order-invariant across choices", () => {
  const hash1 = computeDecisionFrameId(SAMPLE_REQUEST);
  const reordered: DecisionRequest = {
    ...SAMPLE_REQUEST,
    choices: [
      { id: "run_tests", label: "Run test suite" },
      { id: "edit", label: "Edit parser" },
      { id: "inspect", label: "Inspect evidence" },
    ],
  };
  const hash2 = computeDecisionFrameId(reordered);
  assert.equal(hash1, hash2, "Choices order should not affect frameId");

  const differentState: DecisionRequest = {
    ...SAMPLE_REQUEST,
    state: "Failing test in lexer",
  };
  const hash3 = computeDecisionFrameId(differentState);
  assert.notEqual(hash1, hash3, "Different state must produce different frameId");
});

test("MemoizedDecisionProvider returns cached result on identical frame and repoRevision", async () => {
  const inner = mockProvider([SAMPLE_RESULT]);
  let currentRev = "c3b2d8c";
  const memo = new MemoizedDecisionProvider(inner, {
    getRepoRevision: () => currentRev,
  });

  // First call: cache miss
  const res1 = await memo.decide(SAMPLE_REQUEST);
  assert.equal(inner.calls, 1);
  assert.deepEqual(res1.selected, ["inspect"]);
  assert.equal(res1.identity.cached, undefined);
  assert.equal(memo.stats().misses, 1);
  assert.equal(memo.stats().hits, 0);

  // Second call: cache hit
  const res2 = await memo.decide(SAMPLE_REQUEST);
  assert.equal(inner.calls, 1, "Underlying provider should not be called on cache hit");
  assert.deepEqual(res2.selected, ["inspect"]);
  assert.equal(res2.identity.cached, true);
  assert.equal(res2.usage?.latencyMs, 0);
  assert.equal(memo.stats().hits, 1);
  assert.equal(memo.stats().hitRate, 0.5);

  // Revision change: cache miss
  currentRev = "9f21ab0";
  const res3 = await memo.decide(SAMPLE_REQUEST);
  assert.equal(inner.calls, 2, "Different repo revision should invalidate cache");
  assert.equal(memo.stats().misses, 2);
  assert.equal(memo.stats().hits, 1);
});

test("MemoizedDecisionProvider respects TTL expiry", async () => {
  const inner = mockProvider([SAMPLE_RESULT]);
  const memo = new MemoizedDecisionProvider(inner, {
    ttlMs: 50, // 50ms TTL
  });

  await memo.decide(SAMPLE_REQUEST);
  assert.equal(inner.calls, 1);

  // Immediate repeat: hit
  await memo.decide(SAMPLE_REQUEST);
  assert.equal(inner.calls, 1);

  // Wait for TTL to expire
  await new Promise((r) => setTimeout(r, 60));

  // Repeat after expiry: miss
  await memo.decide(SAMPLE_REQUEST);
  assert.equal(inner.calls, 2);
});

test("MemoizedDecisionProvider enforces LRU eviction at maxEntries", async () => {
  const inner = mockProvider([SAMPLE_RESULT]);
  const memo = new MemoizedDecisionProvider(inner, {
    maxEntries: 2,
  });

  const req1 = { ...SAMPLE_REQUEST, question: "q1" };
  const req2 = { ...SAMPLE_REQUEST, question: "q2" };
  const req3 = { ...SAMPLE_REQUEST, question: "q3" };

  await memo.decide(req1);
  await memo.decide(req2);
  assert.equal(memo.stats().entries, 2);

  // Third request evicts req1
  await memo.decide(req3);
  assert.equal(memo.stats().entries, 2);
  assert.equal(memo.stats().evictions, 1);

  assert.equal(memo.has(req1), false);
  assert.equal(memo.has(req2), true);
  assert.equal(memo.has(req3), true);
});

test("MemoizedDecisionProvider can be disabled and dumped/loaded", async () => {
  const inner = mockProvider([SAMPLE_RESULT]);
  const memo = new MemoizedDecisionProvider(inner);

  await memo.decide(SAMPLE_REQUEST);
  assert.equal(memo.stats().entries, 1);

  const dumped = memo.dump();
  assert.equal(dumped.length, 1);

  const memo2 = new MemoizedDecisionProvider(inner);
  assert.equal(memo2.stats().entries, 0);
  memo2.load(dumped);
  assert.equal(memo2.stats().entries, 1);

  // Verify memo2 hits from loaded state
  const res = await memo2.decide(SAMPLE_REQUEST);
  assert.equal(res.identity.cached, true);
  assert.equal(inner.calls, 1);
});
