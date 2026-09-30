import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildInitConfig,
  decide,
  detectVerifyCommand,
  executeTask,
  getRun,
  getRunEvents,
  LatticeServiceError,
  listRuns,
  parseCommandLine,
  parseDecisionRequest,
  resolveRunId,
  runDoctor,
  writeConfig,
} from "./index.js";

async function tempProject(config?: unknown): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-service-"));
  if (config) {
    await mkdir(join(cwd, ".lattice"));
    await writeFile(join(cwd, ".lattice", "config.json"), JSON.stringify(config));
  }
  return cwd;
}

const verifyOk = {
  command: process.execPath,
  args: ["-e", "process.stdout.write('ok')"],
};

test("executeTask without config records evidence-only runs that list and resolve", async () => {
  const cwd = await tempProject();
  const first = await executeTask("first task", { cwd });
  const second = await executeTask("second task", { cwd });
  assert.equal(first.runtimeMode, "evidence-only");

  const runs = await listRuns({ cwd });
  assert.equal(runs.length, 2);
  assert.equal(runs[0]!.runId, second.result.runId);
  assert.equal(runs[0]!.status, "completed");
  assert.equal(runs[0]!.task, "second task");
  assert.equal(runs[0]!.evidence, 1);
  assert.equal("tap" in runs[0]!, false);

  assert.equal(await resolveRunId("latest", cwd), second.result.runId);
  assert.equal(
    await resolveRunId(first.result.runId.slice(0, 12), cwd),
    first.result.runId,
  );

  const detail = await getRun(first.result.runId, cwd);
  assert.equal(detail.tap?.task, "first task");
  const events = await getRunEvents(first.result.runId, cwd);
  assert.equal(events.at(-1)?.type, "run.completed");
});

test("observe mode downgrades an auto config and still runs the verifier", async () => {
  const cwd = await tempProject({
    mode: "auto",
    model: { baseUrl: "http://127.0.0.1:9/v1", model: "unused" },
    agent: { preset: "qwen-code" },
    verify: verifyOk,
  });
  const { result, runtimeMode, configPath } = await executeTask("observe only", {
    cwd,
    mode: "observe",
  });
  assert.equal(runtimeMode, "observe");
  assert.ok(configPath?.endsWith("config.json"));
  assert.equal(result.tap.evidence[1]?.kind, "command");
});

test("configured auto mode without a verifier is a config_error", async () => {
  const cwd = await tempProject({
    mode: "auto",
    model: { baseUrl: "http://127.0.0.1:9/v1", model: "unused" },
    agent: { preset: "qwen-code" },
  });
  await assert.rejects(
    executeTask("needs verifier", { cwd }),
    (error: unknown) =>
      error instanceof LatticeServiceError && error.code === "config_error",
  );
});

test("run lookup rejects traversal and reports missing runs", async () => {
  const cwd = await tempProject();
  await assert.rejects(resolveRunId("../../etc/passwd", cwd), /invalid run id/);
  await assert.rejects(resolveRunId("latest", cwd), /no runs recorded/);
  await assert.rejects(
    resolveRunId("abc", cwd),
    (error: unknown) =>
      error instanceof LatticeServiceError && error.code === "not_found",
  );
});

test("decision requests are validated and random provider works offline", async () => {
  assert.throws(() => parseDecisionRequest({ question: "q", choices: [] }), /choices/);
  assert.throws(
    () =>
      parseDecisionRequest({
        question: "q",
        choices: [
          { id: "a", label: "A" },
          { id: "a", label: "again" },
        ],
      }),
    /duplicate/,
  );

  const request = parseDecisionRequest({
    question: "Which first?",
    choices: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
  });
  const result = await decide(request, { provider: "random" });
  assert.equal(result.identity.provider, "random");
  assert.equal(result.selected.length, 1);

  const cwd = await tempProject();
  await assert.rejects(decide(request, { cwd }), /no decision model configured/);
});

test("init builds validated configs and falls back to observe without a verifier", () => {
  const withVerify = buildInitConfig({
    preset: "ollama",
    verify: parseCommandLine("npm test"),
  });
  assert.equal(withVerify.config.mode, "auto");
  assert.equal(withVerify.config.model?.model, "qwen3-coder");
  assert.deepEqual(withVerify.config.verify?.args, ["test"]);
  assert.deepEqual(withVerify.warnings, []);

  const noVerify = buildInitConfig({ preset: "vllm", model: "Qwen/Qwen3-8B" });
  assert.equal(noVerify.config.mode, "observe");
  assert.equal(noVerify.warnings.length, 1);

  assert.throws(() => buildInitConfig({ preset: "vllm" }), /requires a model/);
  const hosted = buildInitConfig({
    preset: "openai-compatible",
    baseUrl: "https://example.invalid/v1",
    model: "m",
    agent: "opencode",
    verify: parseCommandLine("cargo test"),
  });
  assert.equal(hosted.config.model?.apiKeyEnv, "LATTICE_API_KEY");
  assert.equal(hosted.config.agent?.preset, "opencode");
});

test("detectVerifyCommand and writeConfig", async () => {
  const cwd = await tempProject();
  assert.equal(await detectVerifyCommand(cwd), undefined);
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
  );
  assert.equal(await detectVerifyCommand(cwd), undefined);
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  assert.deepEqual(await detectVerifyCommand(cwd), { command: "npm", args: ["test"] });

  const { config } = buildInitConfig({ preset: "observe" });
  const path = await writeConfig(config, { cwd });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { mode: "observe" });
  assert.match(await readFile(join(cwd, ".lattice", ".gitignore"), "utf8"), /runs\//);
  await assert.rejects(writeConfig(config, { cwd }), /already exists/);
  await writeConfig(config, { cwd, force: true });
});

test("doctor reports config and model reachability without a live server", async () => {
  const none = await runDoctor({ cwd: await tempProject() });
  assert.equal(none.checks.find((c) => c.id === "config")?.status, "warn");

  const cwd = await tempProject({
    mode: "auto",
    model: { baseUrl: "http://models.test/v1", model: "qwen3-coder" },
    agent: { preset: "qwen-code", command: process.execPath },
    verify: verifyOk,
  });
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ data: [{ id: "qwen3-coder:latest" }] }), {
      status: 200,
    })) as typeof fetch;
  const report = await runDoctor({ cwd, fetchImpl });
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
  assert.equal(byId["config.auto"], "ok");
  assert.equal(byId["model.default"], "ok");
  assert.equal(byId["agent"], "ok");
  assert.equal(byId["verify"], "ok");

  const missingModel = await runDoctor({
    cwd,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ data: [{ id: "llama3" }] }))) as typeof fetch,
  });
  assert.equal(
    missingModel.checks.find((c) => c.id === "model.default")?.status,
    "warn",
  );

  const offline = await runDoctor({ cwd, network: false });
  assert.equal(offline.checks.find((c) => c.id === "model.default")?.status, "skip");

  const broken = await tempProject();
  await mkdir(join(broken, ".lattice"), { recursive: true });
  await writeFile(join(broken, ".lattice", "config.json"), "{ not json");
  const bad = await runDoctor({ cwd: broken });
  assert.equal(bad.ok, false);
});
