import assert from "node:assert/strict";
import test from "node:test";
import type {
  DecisionProvider,
  DecisionRequest,
  GeneratorProvider,
  GeneratorRequest,
  GeneratorResult,
} from "@lattice/protocol";
import { DecisionRoutedGenerator } from "./model-routing.js";
import { parseLatticeConfig, createRunTaskOptions } from "./index.js";

const request: GeneratorRequest = { prompt: "Fix the failing TypeScript test" };

function candidate(id: string, generate: (request: GeneratorRequest) => Promise<GeneratorResult>) {
  return {
    id, maxTokens: 400, maxContextTokens: 8000,
    provider: { generate } satisfies GeneratorProvider,
  };
}

function reply(model: string, costUsd = 0.02): GeneratorResult {
  return {
    text: "a proposal",
    identity: { provider: "test", model },
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd, latencyMs: 10 },
  };
}

function selector(
  choose: (request: DecisionRequest) => string,
  calls: DecisionRequest[],
): DecisionProvider {
  return {
    async decide(req) {
      calls.push(req);
      return {
        selected: [choose(req)],
        scores: {},
        identity: { provider: "test-decision", model: "small-choice" },
        usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22, costUsd: 0.001, latencyMs: 3 },
      };
    },
  };
}

test("decision model chooses only eligible pool members and its cost is accounted", async () => {
  const calls: DecisionRequest[] = [];
  const invoked: string[] = [];
  const pool = new DecisionRoutedGenerator([
    { ...candidate("unavailable", async () => { throw Error("must not call"); }), available: false },
    { ...candidate("cheap", async () => { invoked.push("cheap"); return reply("cheap"); }),
      remainingRequests: 3, remainingTokens: 10000 },
    { ...candidate("strong", async () => { invoked.push("strong"); return reply("strong"); }),
      remainingRequests: 1, verifiedSuccessRate: 0.91, verifiedSamples: 40 },
  ], selector(() => "strong", calls));

  const result = await pool.generate(request);
  assert.deepEqual(invoked, ["strong"]);
  assert.deepEqual(calls[0]!.choices.map((value) => value.id), ["cheap", "strong"]);
  assert.equal(result.identity.model, "strong");
  assert.equal(result.routing?.selected, "strong");
  assert.equal(result.routing?.selectionMode, "decision-model");
  assert.equal(result.usage.totalTokens, 142);
  assert.equal(result.usage.costUsd, 0.021);
  assert.equal(result.routing?.selectorIdentity?.model, "small-choice");
});

test("sole eligible model needs no selector call; reported usage depletes run quota", async () => {
  const calls: DecisionRequest[] = [];
  const generator = new DecisionRoutedGenerator([
    { ...candidate("one", async () => reply("one")), remainingRequests: 1, remainingTokens: 1000 },
  ], selector(() => "one", calls));
  const first = await generator.generate(request);
  assert.equal(first.routing?.selectionMode, "sole-eligible");
  assert.equal(first.usage.totalTokens, 120);
  assert.equal(calls.length, 0);
  await assert.rejects(() => generator.generate(request), /No eligible generator model remains/);
});

test("unknown price cannot bypass configured spending headroom", async () => {
  const generator = new DecisionRoutedGenerator([
    { ...candidate("unpriced", async () => reply("unpriced")), remainingCostUsd: 0.5 },
    { ...candidate("too-expensive", async () => reply("too-expensive")),
      maxTokens: 1000, remainingCostUsd: 0.00001,
      inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
  ], selector(() => "unpriced", []));
  await assert.rejects(() => generator.generate(request), /No eligible generator model remains/);
});

test("rate limit marks one endpoint unavailable and reselects another", async () => {
  const calls: DecisionRequest[] = [];
  const invoked: string[] = [];
  const generator = new DecisionRoutedGenerator([
    candidate("limited", async () => { invoked.push("limited"); throw Error("Provider request failed: 429 Too Many Requests: quota"); }),
    candidate("backup", async () => { invoked.push("backup"); return reply("backup"); }),
  ], selector(() => "limited", calls));
  const result = await generator.generate(request);
  assert.deepEqual(invoked, ["limited", "backup"]);
  assert.equal(result.routing?.selected, "backup");
  assert.deepEqual(result.routing?.attempted, ["limited", "backup"]);
  assert.equal(calls.length, 1);
});

test("unknown or invented selection never invokes generator", async () => {
  for (const answer of ["__none__", "not-configured"]) {
    let invoked = 0;
    const gen = new DecisionRoutedGenerator([
      candidate("a", async () => { invoked++; return reply("a"); }),
      candidate("b", async () => { invoked++; return reply("b"); }),
    ], selector(() => answer, []));
    await assert.rejects(() => gen.generate(request), /abstained|ineligible/);
    assert.equal(invoked, 0);
  }
});

test("unknown usage fails closed for subsequent quota-constrained calls", async () => {
  const gen = new DecisionRoutedGenerator([
    candidate("local", async () => ({
      ...reply("local"),
      usage: { latencyMs: 10 },
    })),
  ].map((item) => ({ ...item, remainingTokens: 10000 })), selector(() => "local", []));
  await gen.generate(request);
  await assert.rejects(() => gen.generate(request), /No eligible generator model remains/);
});

test("config parser validates routed pool, preserves existing auto wiring", () => {
  const makeConfig = (generatorPool: unknown) => ({
    mode: "auto",
    models: {
      decision: { baseUrl: "http://localhost:11434/v1", model: "small" },
      generatorPool,
    },
    agent: { preset: "qwen-code" },
    verify: { command: "npm", args: ["test"] },
  });
  const config = parseLatticeConfig(makeConfig([{
    id: "large", baseUrl: "http://localhost:11434/v1",
    model: "large", maxTokens: 2048, remainingRequests: 5,
  }]));
  const options = createRunTaskOptions(config);
  assert.ok(options.search?.generator instanceof DecisionRoutedGenerator);
  assert.throws(
    () => parseLatticeConfig(makeConfig([{ id: "bad", baseUrl: "http://localhost", model: "m" }])),
    /maxTokens/,
  );
  assert.throws(
    () => parseLatticeConfig(makeConfig([
      { id: "dup", baseUrl: "http://localhost", model: "m", maxTokens: 100 },
      { id: "dup", baseUrl: "http://localhost", model: "m2", maxTokens: 100 },
    ])),
    /unique/,
  );
});
