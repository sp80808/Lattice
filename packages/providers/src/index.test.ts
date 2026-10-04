import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAICompatibleDecisionProvider,
  RandomDecisionProvider,
  seededRandom,
} from "./index.js";

test("random provider adds an explicit unknown choice", async () => {
  const provider = new RandomDecisionProvider(() => 0.99);
  const result = await provider.decide({
    question: "What next?",
    choices: [
      { id: "a", label: "Inspect parser" },
      { id: "b", label: "Run tests" },
    ],
  });

  assert.deepEqual(result.selected, ["__none__"]);
  assert.equal(Object.keys(result.scores).length, 3);
});

test("OpenAI-compatible decision provider validates selected IDs", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                '{"selected":"b","scores":{"a":1,"b":3,"__none__":0}}',
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const provider = new OpenAICompatibleDecisionProvider({
    baseUrl: "http://local.test/v1",
    model: "qwen-test",
    fetchImpl,
  });

  const result = await provider.decide({
    state: "test b is failing",
    question: "Which action is most useful?",
    choices: [
      { id: "a", label: "Read docs" },
      { id: "b", label: "Reproduce test" },
    ],
  });

  assert.deepEqual(result.selected, ["b"]);
  assert.equal(result.scores.b, 0.75);
  assert.equal(result.confidence, 0.75);
  assert.equal(result.usage.totalTokens, 15);
});

test("OpenAI-compatible decision provider rejects hallucinated choice IDs", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"selected":"invented"}' } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const provider = new OpenAICompatibleDecisionProvider({
    baseUrl: "http://local.test/v1",
    model: "qwen-test",
    fetchImpl,
  });

  await assert.rejects(
    () =>
      provider.decide({
        question: "Choose",
        choices: [{ id: "known", label: "Known" }],
      }),
    /unknown choice ID/,
  );
});

test("random provider can exclude unknown and replays by seed", async () => {
  const request = {
    question: "Which patch?",
    choices: [
      { id: "a", label: "a" },
      { id: "b", label: "b" },
      { id: "c", label: "c" },
    ],
  };
  const picks = async (seed: number) => {
    const provider = new RandomDecisionProvider(seededRandom(seed), { allowUnknown: false });
    const out: string[] = [];
    for (let i = 0; i < 20; i++) out.push(...(await provider.decide(request)).selected);
    return out;
  };
  const first = await picks(7);
  assert.deepEqual(await picks(7), first);
  assert.ok(first.every((id) => id !== "__none__"));
  assert.ok(new Set(first).size > 1);
});
