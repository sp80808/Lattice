// Embedded planning example using an existing Codex login, without an API key.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTask } from "@lattice/core";
import { runCommand } from "@lattice/execution";

function completion(stdout, latencyMs) {
  const events = stdout.trim().split("\n").map(line => JSON.parse(line));
  const failure = events.find(event => event.type === "turn.failed" || event.type === "error");
  assert.ok(!failure, `Codex failed: ${JSON.stringify(failure)}`);
  const items = events.filter(event => event.type === "item.completed").map(event => event.item);
  assert.ok(items.every(item => item.type === "agent_message" || item.type === "reasoning"), "Planning trial must not use tools");
  const text = items.filter(item => item.type === "agent_message").at(-1)?.text;
  assert.ok(text?.trim(), "Codex must return a draft");
  const usage = events.findLast(event => event.type === "turn.completed")?.usage;
  assert.ok(usage, "Codex must complete the turn and report usage");
  return {
    text,
    identity: { provider: "codex-cli" },
    usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
      totalTokens: usage.input_tokens + usage.output_tokens, latencyMs },
  };
}

if (process.argv[2] === "--self-test") {
  const fixture = [
    { type: "item.completed", item: { type: "agent_message", text: "Draft" } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
  ].map(event => JSON.stringify(event)).join("\n");
  assert.equal(completion(fixture, 1).usage.totalTokens, 12);
  assert.throws(() => completion('{"type":"turn.failed"}', 0), /failed/);
  assert.throws(() => completion(fixture.replace("agent_message", "command_execution"), 0), /must not use tools/);
  console.log("Codex planning adapter self-check passed");
} else {
  const [repository, requestFile, outputDirectory] = process.argv.slice(2);
  assert.ok(repository && requestFile && outputDirectory,
    "Usage: node examples/planning/plan-with-codex.mjs <repo> <request.json> <new-output-directory>");
  const request = JSON.parse(await readFile(resolve(requestFile), "utf8"));
  assert.equal(typeof request.task, "string");
  assert.ok(Array.isArray(request.files));
  const output = resolve(outputDirectory);
  await mkdir(output); // Refuse to overwrite a previous trial.
  const scratch = await mkdtemp(join(tmpdir(), "lattice-plan-codex-"));
  try {
    const result = await runTask(request.task, {
      cwd: resolve(repository), latticeDir: output,
      plan: { files: request.files, generator: { generate: async (input) => {
        // shortcut: Codex CLI has no output-token cap; enforce a 3-minute timeout and report actual usage.
        const child = await runCommand({
          command: "codex",
          args: ["exec", "--sandbox", "read-only", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "--json", "-"],
          cwd: scratch, timeoutMs: 180_000, maxOutputBytes: 256_000,
          stdin: `${input.system}\n\n${input.prompt}\n\nReturn at most ${input.maxTokens} output tokens. Do not use tools.\n\nSources:\n${input.context.join("\n")}`,
        });
        await writeFile(join(output, "codex-events.jsonl"), child.stdout);
        assert.ok(!child.timedOut && !child.outputTruncated, "Codex trial exceeded time/output limits");
        assert.equal(child.exitCode, 0, `Codex exited ${child.exitCode}: ${child.stderr.slice(-2000)}`);
        return completion(child.stdout, child.durationMs);
      } } },
    });
    assert.equal(result.tap.evidence.at(-1).verified, false);
    assert.deepEqual(result.tap.verification, []);
    await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
    await writeFile(join(output, "plan.md"), result.summary + "\n");
    console.log(JSON.stringify({ runId: result.runId, plan: join(output, "plan.md"), events: result.eventLogPath }));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
