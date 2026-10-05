import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OpenAICompatibleDecisionProvider,
  OpenAICompatibleGeneratorProvider,
  RandomDecisionProvider,
  claudeCodeFetch,
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

test("OpenAI-compatible generator sends max_tokens when configured", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  };
  const config = { baseUrl: "http://example.test/v1", model: "m", fetchImpl };
  await new OpenAICompatibleGeneratorProvider({ ...config, maxTokens: 2048 }).generate({ prompt: "p" });
  await new OpenAICompatibleGeneratorProvider(config).generate({ prompt: "p" });
  assert.equal(bodies[0]!.max_tokens, 2048);
  assert.equal("max_tokens" in bodies[1]!, false);
});

test("the Claude Code bridge turns a claude -p result into a chat completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lattice-fake-claude-"));
  const fake = join(dir, "claude");
  // Echoes its arguments and stdin so the test can see what was sent.
  await writeFile(
    fake,
    `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (c) => (input += c)).on("end", () => {
  const args = process.argv.slice(2);
  const failing = input.includes("FAIL");
  console.log(JSON.stringify({
    is_error: failing || input.includes("LOGIN"),
    result: input.includes("LOGIN") ? "Not logged in · Please run /login" : failing ? "You've hit your usage limit" : JSON.stringify({ args, input }),
    total_cost_usd: 0.25,
    usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 7, output_tokens: 20 },
  }));
});
`,
  );
  await chmod(fake, 0o755);
  const provider = new OpenAICompatibleGeneratorProvider({
    baseUrl: "claude-code://local",
    model: "sonnet",
    fetchImpl: claudeCodeFetch({ command: fake, model: "sonnet" }),
  });
  const result = await provider.generate({ system: "SYS", prompt: "PROMPT", context: ["CTX"] });
  const echoed = JSON.parse(result.text) as { args: string[]; input: string };
  assert.deepEqual(echoed.args.slice(echoed.args.indexOf("--system-prompt"), echoed.args.indexOf("--system-prompt") + 2), ["--system-prompt", "SYS"]);
  assert.ok(echoed.args.includes("--no-session-persistence"));
  assert.equal(echoed.args[echoed.args.indexOf("--tools") + 1], "");
  assert.equal(echoed.args[echoed.args.indexOf("--model") + 1], "sonnet");
  assert.match(echoed.input, /PROMPT[\s\S]*CTX/);
  assert.deepEqual(
    { input: result.usage.inputTokens, output: result.usage.outputTokens, cost: result.usage.costUsd },
    { input: 110, output: 20, cost: 0.25 },
  );
  await assert.rejects(provider.generate({ prompt: "FAIL" }), /Provider request failed: 429/);
  await assert.rejects(provider.generate({ prompt: "LOGIN" }), /Provider request failed: 401/);
});
