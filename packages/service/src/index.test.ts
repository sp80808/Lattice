import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildInitConfig,
  decide,
  detectVerifyCommand,
  executeTask,
  findExecutable,
  followRunEvents,
  getRun,
  getRunEvents,
  LatticeServiceError,
  listRuns,
  parseCommandLine,
  parseDecisionRequest,
  resolveRunId,
  ReviewBroker,
  runDoctor,
  startTask,
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

const slowVerify = {
  command: process.execPath,
  args: ["-e", "setTimeout(() => process.stdout.write('slow ok'), 400)"],
};

test("startTask resolves once the run is logged and follow tails it live", async () => {
  const cwd = await tempProject({ mode: "observe", verify: slowVerify });
  const started = await startTask("slow observe", { cwd });
  assert.match(started.runId, /^[0-9a-f-]{36}$/);

  const listed = await listRuns({ cwd });
  assert.equal(listed[0]?.status, "incomplete");

  const types: string[] = [];
  for await (const event of followRunEvents(started.runId, cwd, { pollMs: 25 })) {
    types.push(event.type);
  }
  assert.equal(types[0], "run.started");
  assert.equal(types.at(-1), "run.completed");
  assert.ok(types.includes("tap.created"));

  const outcome = await started.done;
  assert.equal(outcome.result.runId, started.runId);

  const resumed: number[] = [];
  for await (const event of followRunEvents(started.runId, cwd, { after: 4 })) {
    resumed.push(event.seq);
  }
  assert.equal(resumed[0], 5);
});

test("startTask rejects config errors before any run exists", async () => {
  const cwd = await tempProject({
    mode: "auto",
    model: { baseUrl: "http://127.0.0.1:9/v1", model: "unused" },
    agent: { preset: "qwen-code" },
  });
  await assert.rejects(startTask("no verifier", { cwd }), /verify/);
  await assert.rejects(startTask("   ", { cwd }), /non-empty/);
  assert.deepEqual(await listRuns({ cwd }), []);
});

test("followRunEvents stops when aborted", async () => {
  const cwd = await tempProject({ mode: "observe", verify: slowVerify });
  const started = await startTask("abort follow", { cwd });
  const controller = new AbortController();
  const seen: string[] = [];
  for await (const event of followRunEvents(started.runId, cwd, { signal: controller.signal, pollMs: 25 })) {
    seen.push(event.type);
    controller.abort();
  }
  assert.deepEqual(seen, ["run.started"]);
  await started.done;
});

function reviewRequest(round: number) {
  return {
    round,
    reasons: ["confidence 0.400 below 0.720"],
    selectedCandidates: [],
    decision: {
      selected: ["a"],
      scores: { a: 0.4, b: 0.35, __none__: 0.25 },
      confidence: 0.4,
      identity: { provider: "test" },
      usage: { latencyMs: 1 },
    },
    frame: {
      id: "frame1",
      class: "next-action" as const,
      objective: "o",
      question: "Which next?",
      criteria: [],
      state: "",
      evidenceIds: ["ev:1"],
      choices: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "__none__", label: "none" },
      ],
      allowUnknown: true,
      audit: [],
    },
  };
}

test("ReviewBroker parks reviews until a remote answer arrives", async () => {
  const broker = new ReviewBroker();
  const runId = "11111111-2222-3333-4444-555555555555";
  const reviewer = broker.reviewerFor(() => runId);

  const pending = reviewer(reviewRequest(1));
  const [listed] = broker.list();
  assert.equal(listed?.runId, runId);
  assert.equal(listed?.reviewId, "frame1:r1");
  assert.deepEqual(listed?.modelSelection, ["a"]);
  assert.equal(broker.get("11111111").question, "Which next?");
  assert.equal(broker.get("latest").runId, runId);

  assert.throws(() => broker.answer(runId, { action: "maybe" }), /action must be/);
  assert.throws(() => broker.answer(runId, { action: "replace", selected: ["__none__"] }), /non-empty subset of a, b/);
  assert.throws(() => broker.answer(runId, { action: "approve", reviewId: "old:r0" }), /stale/);
  assert.equal(broker.list().length, 1, "invalid answers leave the review pending");

  broker.answer(runId, { action: "replace", selected: ["b"], note: "b is cheaper", reviewId: "frame1:r1" });
  assert.deepEqual(await pending, { action: "replace", selected: ["b"], note: "b is cheaper" });
  assert.deepEqual(broker.list(), []);
  assert.throws(() => broker.get(runId), /no pending review/);
});

test("ReviewBroker stops unanswered reviews after the timeout", async () => {
  const broker = new ReviewBroker({ timeoutMs: 20 });
  // The broker unrefs its timer so a parked review never holds a process open;
  // keep this test's event loop alive until the timeout fires.
  const keepAlive = setInterval(() => {}, 1_000);
  const result = await broker.reviewerFor(() => "abc")(reviewRequest(2)).finally(() => clearInterval(keepAlive));
  assert.equal(result.action, "stop");
  assert.match(result.note ?? "", /no remote review within 20ms/);
  assert.deepEqual(broker.list(), []);

  const early = await broker.reviewerFor(() => undefined)(reviewRequest(1));
  assert.equal(early.action, "stop");
});

test("findExecutable searches PATH and honours PATHEXT on Windows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lattice-path-"));
  await writeFile(join(dir, "tool"), "");
  await chmod(join(dir, "tool"), 0o755);
  await writeFile(join(dir, "qwen.CMD"), "");
  await chmod(join(dir, "qwen.CMD"), 0o755);
  await writeFile(join(dir, "plain"), "");

  assert.equal(await findExecutable("tool", `/nonexistent:${dir}`, { platform: "linux" }), join(dir, "tool"));
  assert.equal(await findExecutable("plain", dir, { platform: "linux" }), undefined, "not executable");
  assert.equal(await findExecutable("qwen", dir, { platform: "linux" }), undefined);
  assert.equal(await findExecutable(join(dir, "tool"), "", { platform: "linux" }), join(dir, "tool"));

  assert.equal(
    await findExecutable("qwen", `C:\\nope;${dir}`, { platform: "win32", pathExt: ".EXE;.CMD" }),
    join(dir, "qwen.CMD"),
  );
  assert.equal(await findExecutable("qwen.CMD", dir, { platform: "win32", pathExt: ".EXE" }), join(dir, "qwen.CMD"));
  assert.equal(await findExecutable("qwen", dir, { platform: "win32", pathExt: ".EXE" }), undefined);
});
