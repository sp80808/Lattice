import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAICompatibleDecisionProvider,
  RandomDecisionProvider,
  SystemOneDecisionProvider,
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

test("SystemOne decision provider maps choice and probabilities accurately", async () => {
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(init?.body as string);
    assert.equal(body.model, "tev1:0.8b");
    assert.equal(body.keep_alive, "30m");
    assert.ok(body.questions?.next_action?.criteria?.inspect);

    return new Response(
      JSON.stringify({
        answers: {
          next_action: {
            type: "choice",
            choice: "inspect",
            probabilities: {
              inspect: 0.85,
              edit: 0.1,
              __none__: 0.05,
            },
            confidence: 0.85,
          },
        },
        usage: {
          input_tokens: 120,
          output_tokens: 0,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const provider = new SystemOneDecisionProvider({
    baseUrl: "http://127.0.0.1:11434",
    model: "tev1:0.8b",
    fetchImpl,
  });

  const result = await provider.decide({
    state: "Failing test output",
    question: "Select the single best next action for the engineering task.",
    choices: [
      { id: "inspect", label: "Inspect error log" },
      { id: "edit", label: "Edit source" },
    ],
  });

  assert.deepEqual(result.selected, ["inspect"]);
  assert.equal(result.scores.inspect, 0.85);
  assert.equal(result.confidence, 0.85);
  assert.equal(result.identity.provider, "systemone");
  assert.equal(result.usage.inputTokens, 120);
});
