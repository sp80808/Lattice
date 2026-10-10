import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAICompatibleDecisionProvider,
  OpenAICompatibleGeneratorProvider,
  RandomDecisionProvider,
  SystemOneDecisionProvider,
} from "./index.js";

test("generator forwards an explicit output cap and rejects invalid budgets", async () => {
  let calls = 0;
  const provider = new OpenAICompatibleGeneratorProvider({
    baseUrl: "http://fixture.invalid/v1", model: "fixture",
    fetchImpl: async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(String(init?.body)).max_tokens, 4096);
      return new Response(JSON.stringify({ choices: [{ message: { content: "Draft plan" } }] }));
    },
  });
  assert.equal((await provider.generate({ prompt: "plan", maxTokens: 4096 })).text, "Draft plan");
  for (const maxTokens of [0, -1, 1.5, Infinity, NaN]) {
    await assert.rejects(provider.generate({ prompt: "plan", maxTokens }), /positive integer/);
  }
  assert.equal(calls, 1);
});

test("generator does not present a token-truncated draft as completed", async () => {
  const provider = new OpenAICompatibleGeneratorProvider({
    baseUrl: "http://fixture.invalid/v1", model: "fixture",
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "incomplete" } }] })),
  });
  await assert.rejects(provider.generate({ prompt: "plan", maxTokens: 10 }), /exceeded the token limit/);
});

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

const okBody = JSON.stringify({
  choices: [{ message: { content: '{"selected":"a","scores":{"a":1}}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

/** A fetch stub that fails the first `failures` calls in the requested way, then succeeds. */
function flaky(
  failures: number,
  kind: "503" | "429" | "400" | "network",
  counter: { calls: number },
): typeof fetch {
  return async () => {
    counter.calls++;
    if (counter.calls <= failures) {
      if (kind === "network") throw new TypeError("fetch failed");
      return new Response("busy", { status: kind === "503" ? 503 : kind === "429" ? 429 : 400 });
    }
    return new Response(okBody, { status: 200, headers: { "content-type": "application/json" } });
  };
}

const decisionRequest = {
  question: "Which action?",
  choices: [{ id: "a", label: "Read docs" }],
};

test("transient provider failures are retried with backoff and then succeed", async () => {
  for (const kind of ["503", "429", "network"] as const) {
    const counter = { calls: 0 };
    const provider = new OpenAICompatibleDecisionProvider({
      baseUrl: "http://local.test/v1",
      model: "qwen-test",
      fetchImpl: flaky(2, kind, counter),
      retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
    });
    const result = await provider.decide(decisionRequest);
    assert.deepEqual(result.selected, ["a"], `${kind} should recover on the third attempt`);
    assert.equal(counter.calls, 3);
  }
});

test("permanent failures fail fast, and the retry budget is respected", async () => {
  const counter = { calls: 0 };
  const permanent = new OpenAICompatibleDecisionProvider({
    baseUrl: "http://local.test/v1",
    model: "qwen-test",
    fetchImpl: flaky(1, "400", counter),
    retry: { attempts: 5, baseDelayMs: 1, maxDelayMs: 5 },
  });
  await assert.rejects(() => permanent.decide(decisionRequest), /Provider request failed: 400/);
  assert.equal(counter.calls, 1, "a 400 is not transient and must not be retried");

  const exhausted = { calls: 0 };
  const provider = new OpenAICompatibleDecisionProvider({
    baseUrl: "http://local.test/v1",
    model: "qwen-test",
    fetchImpl: flaky(10, "503", exhausted),
    retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 5 },
  });
  await assert.rejects(() => provider.decide(decisionRequest), /Provider request failed: 503/);
  assert.equal(exhausted.calls, 2, "stops after the configured attempt count");

  const disabled = { calls: 0 };
  const noRetry = new OpenAICompatibleDecisionProvider({
    baseUrl: "http://local.test/v1",
    model: "qwen-test",
    fetchImpl: flaky(10, "503", disabled),
    retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 5 },
  });
  await assert.rejects(() => noRetry.decide(decisionRequest), /503/);
  assert.equal(disabled.calls, 1, "attempts=1 disables retries");
});

test("a timeout is not retried: the caller owns that budget", async () => {
  const counter = { calls: 0 };
  const slow: typeof fetch = async (_url, init) => {
    counter.calls++;
    return await new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  };
  const provider = new OpenAICompatibleDecisionProvider({
    baseUrl: "http://local.test/v1",
    model: "qwen-test",
    fetchImpl: slow,
    timeoutMs: 10,
    retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
  });
  await assert.rejects(() => provider.decide(decisionRequest), /abort/i);
  assert.equal(counter.calls, 1, "an aborted call is a timeout, not a transient failure");
});
