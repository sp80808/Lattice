import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ArtifactStore,
  CLASS_COMPUTE_UNITS_PER_HOUR,
  ColabClient,
  NO_SESSIONS_OUTPUT,
  classifyAccelerator,
  classifyExperiment,
  classifySession,
  findInefficientCpuSessions,
  parseSessions,
  parseUsage,
  recoverSession,
  safeToStop,
  schedule,
  type ColabSession,
  type ColabUsage,
} from "./index.js";

/** Verbatim output of `colab sessions` on 10 October 2026. */
const LIVE_SESSIONS = `[lattice-train] gpu-t4-s-kkb-ass1c2-3tn83c9gc7dlh | Hardware: T4 | Shape: Standard | Variant: GPU
[lattice-polyglot] m-s-kkb-usc1c2-2l7i8ofnh2abl | Hardware: CPU | Shape: Standard | Variant: DEFAULT
`;

/** Verbatim output of `colab usage` on 10 October 2026. */
const LIVE_USAGE = `Current balance: 196.55 compute units
Usage rate: 1.15/hr
Active assignments: 2
`;

test("the no-active-sessions banner is not parsed as a session named colab", () => {
  assert.deepEqual(parseSessions(NO_SESSIONS_OUTPUT), []);
  assert.deepEqual(parseSessions(""), []);
  assert.deepEqual(parseSessions("[colab] some diagnostic"), []);
  // A real session still parses alongside diagnostics.
  const sessions = parseSessions(`${NO_SESSIONS_OUTPUT}\n${LIVE_SESSIONS}`);
  assert.equal(sessions.length, 2);
});

test("parses the live session list into typed sessions", () => {
  const sessions = parseSessions(LIVE_SESSIONS);
  assert.equal(sessions.length, 2);
  assert.deepEqual(
    sessions.map((s) => [s.name, s.accelerator]),
    [
      ["lattice-train", "gpu"],
      ["lattice-polyglot", "cpu"],
    ],
  );
  assert.equal(sessions[0].acceleratorLabel, "T4");
  assert.equal(sessions[1].acceleratorLabel, "CPU");
});

test("a T4 session is classified as GPU and a NONE/CPU session as CPU", () => {
  assert.equal(classifyAccelerator("T4"), "gpu");
  assert.equal(classifyAccelerator("NONE"), "cpu");
  assert.equal(classifyAccelerator("CPU"), "cpu");
  assert.equal(classifyAccelerator("A100"), "gpu");
  assert.equal(classifyAccelerator(""), "cpu");
});

test("parses the live usage report", () => {
  const usage = parseUsage(LIVE_USAGE);
  assert.equal(usage.balanceUnits, 196.55);
  assert.equal(usage.usageRatePerHour, 1.15);
  assert.equal(usage.activeAssignments, 2);
});

test("a stale session name resolves gracefully instead of throwing", () => {
  const client = new ColabClient({
    exec: (args) => ({ status: 0, stdout: args[0] === "sessions" ? LIVE_SESSIONS : "", stderr: "" }),
  });
  assert.equal(client.session("lattice-eval"), null);
  const status = client.status("lattice-eval");
  assert.equal(status.stale, true);
  assert.equal(status.session, null);
  // Stopping a stale session is a no-op, not a crash.
  client.stop("lattice-eval");
  assert.ok(client.session("lattice-train"));
});

test("colab errors surface as ColabCommandError with the exit status", () => {
  const client = new ColabClient({ exec: () => ({ status: 3, stdout: "", stderr: "boom" }) });
  assert.throws(() => client.sessions(), /exit 3/);
});

test("sessions are discovered live; nothing is cached or hardcoded", () => {
  let calls = 0;
  const client = new ColabClient({
    exec: (args) => {
      calls++;
      return { status: 0, stdout: args[0] === "sessions" ? LIVE_SESSIONS : "", stderr: "" };
    },
  });
  client.sessions();
  client.sessions();
  assert.equal(calls, 2, "every call re-discovers the live session list");
});

test("an idle CPU session running tests is CPU-appropriate verification", () => {
  const sessions = parseSessions(LIVE_SESSIONS);
  const cpu = sessions.find((s) => s.name === "lattice-polyglot")!;
  assert.equal(
    classifySession(cpu, { testProcessRunning: true, cpuLoad: 0.2 }),
    "cpu-verification",
  );
});

test("a CPU session with a model loaded is flagged as inefficient inference", () => {
  const sessions = parseSessions(LIVE_SESSIONS);
  const cpu = sessions.find((s) => s.name === "lattice-polyglot")!;
  assert.equal(classifySession(cpu, { modelProcessRunning: true }), "cpu-inference");
  const problems = findInefficientCpuSessions(sessions, new Map([["lattice-polyglot", { modelProcessRunning: true }]]));
  assert.equal(problems.length, 1);
  assert.match(problems[0].issue, /inefficient/);
});

test("an idle CPU session is reported as burning compute units", () => {
  const sessions = parseSessions(LIVE_SESSIONS);
  const problems = findInefficientCpuSessions(
    sessions,
    new Map([["lattice-polyglot", { cpuLoad: 0.02 }]]),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0].issue, /idle/);
});

test("an active GPU session is classified separately from an idle one", () => {
  const sessions = parseSessions(LIVE_SESSIONS);
  const gpu = sessions.find((s) => s.name === "lattice-train")!;
  assert.equal(classifySession(gpu, { gpuUtilizationPct: 80 }), "gpu-training");
  assert.equal(classifySession(gpu, { gpuUtilizationPct: 0 }), "gpu-benchmark");
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

function context(overrides: Partial<Parameters<typeof schedule>[1]> = {}): Parameters<typeof schedule>[1] {
  return {
    sessions: parseSessions(LIVE_SESSIONS),
    usage: parseUsage(LIVE_USAGE),
    ...overrides,
  };
}

test("tests, compiles and verification stay on CPU", () => {
  for (const kind of ["test", "compile", "verify", "preprocess"] as const) {
    const decision = schedule({ kind, accelerationBenefit: 1 }, context());
    assert.equal(decision.backend, "colab-cpu", kind);
    assert.equal(decision.requiresApproval, false);
    assert.equal(decision.estimatedComputeUnitsPerHour, 0, `${kind} must not be billed as GPU`);
  }
});

test("cheap decision inference runs on the local small model, not Colab", () => {
  const decision = schedule({ kind: "decision-inference", accelerationBenefit: 0 }, context());
  assert.equal(decision.backend, "local-model");
  assert.equal(decision.requiresApproval, false);
});

test("training reuses an existing GPU session before provisioning new compute", () => {
  const decision = schedule({ kind: "training", accelerationBenefit: 1 }, context());
  assert.equal(decision.backend, "colab-gpu");
  assert.equal(decision.reuseSession, "lattice-train");
  assert.equal(decision.requiresApproval, false, "reusing an already-running session spends nothing new");
  assert.equal(decision.estimatedComputeUnitsPerHour, CLASS_COMPUTE_UNITS_PER_HOUR["gpu-training"]);
});

test("GPU work that would provision a new paid session requires approval", () => {
  const decision = schedule({ kind: "training", accelerationBenefit: 1 }, context({ sessions: [] }));
  assert.equal(decision.backend, "unavailable");
  assert.equal(decision.requiresApproval, true);
  assert.match(decision.reason, /requires explicit approval/);
});

test("an over-budget GPU request is refused even with approval", () => {
  const decision = schedule(
    { kind: "training", accelerationBenefit: 1 },
    context({ sessions: [], approvedForPaidResources: true, computeUnitBudget: 2 }),
  );
  assert.equal(decision.backend, "unavailable");
  assert.match(decision.reason, /above the configured 2 CU\/hr budget/);
});

test("low-benefit generation does not get a GPU", () => {
  const decision = schedule({ kind: "generation", accelerationBenefit: 0.3 }, context());
  assert.equal(decision.backend, "colab-cpu");
  assert.equal(decision.reuseSession, "lattice-polyglot");
});

// ---------------------------------------------------------------------------
// Artifact recovery
// ---------------------------------------------------------------------------

const ADAPTER_FILES = [
  "adapter_config.json",
  "adapter_model.safetensors",
  "tokenizer.json",
  "tokenizer_config.json",
  "training_metrics.json",
  "README.md",
];

function fakeClient(files: Record<string, string>) {
  const downloads: Array<[string, string, string]> = [];
  return {
    downloads,
    ls: (_session: string, _dir: string) => Object.keys(files),
    download: (session: string, remotePath: string, localPath: string) => {
      const name = remotePath.split("/").pop()!;
      if (!(name in files)) throw new Error(`remote file not found: ${remotePath}`);
      writeFileSync(localPath, files[name]);
      downloads.push([session, remotePath, localPath]);
    },
    session: (name: string): ColabSession => ({
      name,
      endpoint: "e",
      accelerator: name === "lattice-train" ? "gpu" : "cpu",
      acceleratorLabel: name === "lattice-train" ? "T4" : "CPU",
    }),
  };
}

test("recovers a LoRA adapter and classifies the experiment as completed", () => {
  const root = mkdtempSync(join(tmpdir(), "lattice-colab-"));
  try {
    const client = fakeClient({
      "adapter_config.json": "{}",
      "adapter_model.safetensors": "weights",
      "tokenizer.json": "{}",
      "training_metrics.json": '{"post_accuracy": 0.5}',
      README: "readme",
    });
    const store = new ArtifactStore({ root, client });
    const artifacts = store.recover("lattice-train", "/content/lattice-router-lora", ADAPTER_FILES);
    assert.ok(artifacts.some((a) => a.kind === "adapter"));
    assert.ok(artifacts.some((a) => a.kind === "metrics"));
    assert.ok(artifacts.every((a) => existsSync(a.localPath)));

    const { outcome, reason } = classifyExperiment("lora-training", artifacts);
    assert.equal(outcome, "completed");
    assert.match(reason, /adapter weights and run metrics/);

    store.record({
      id: "lattice-train-lora",
      session: "lattice-train",
      kind: "lora-training",
      outcome,
      reason,
      artifacts,
      modelIdentity: { modelId: "THUDM/glm-5.3-flash", provider: "huggingface", device: "cuda" },
      metrics: { post_accuracy: 0.5, accuracy_gain: 0.1667 },
    });
    const manifestPath = store.writeManifest("lattice-train");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.experiments.length, 1);
    assert.equal(manifest.experiments[0].outcome, "completed");
    assert.equal(manifest.experiments[0].modelIdentity.device, "cuda");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a metrics file without adapter weights is interrupted, not completed", () => {
  const root = mkdtempSync(join(tmpdir(), "lattice-colab-"));
  try {
    const client = fakeClient({ "training_metrics.json": "{}" });
    const store = new ArtifactStore({ root, client });
    const artifacts = store.recover("lattice-train", "/content/lattice-router-lora", ADAPTER_FILES);
    const { outcome, reason } = classifyExperiment("lora-training", artifacts);
    assert.equal(outcome, "interrupted");
    assert.match(reason, /adapter weights are missing/);
    assert.equal(safeToStop([]).safe, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Colab-pruned session is recorded as interrupted", () => {
  const { outcome, reason } = classifyExperiment("benchmark", [], { terminatedByColab: true });
  assert.equal(outcome, "interrupted");
  assert.match(reason, /pruned/);
});

test("an unrecoverable experiment is lost and blocks a stop", () => {
  const store = new ArtifactStore({ root: mkdtempSync(join(tmpdir(), "lattice-colab-")) });
  const record = store.record({
    id: "lattice-eval-bench",
    session: "lattice-eval",
    kind: "benchmark",
    outcome: "lost",
    reason: "no artifacts could be recovered from the session",
    artifacts: [],
  });
  const { safe, blockers } = safeToStop([record]);
  assert.equal(safe, false);
  assert.match(blockers[0], /no artifacts recovered/);
  assert.deepEqual(store.needsVerification(), []);
});

test("polyglot test results are unverified baselines, not agent successes", () => {
  const root = mkdtempSync(join(tmpdir(), "lattice-colab-"));
  try {
    const client = fakeClient({ "cpu_run_summary.json": '{"total_evaluated": 2}' });
    const store = new ArtifactStore({ root, client });
    const artifacts = store.recover("lattice-polyglot", "/content/polyglot-results", ["cpu_run_summary.json"]);
    const { outcome, reason } = classifyExperiment("polyglot-cpu-verification", artifacts);
    // A summary with no adapter and no verifier transcript is unverified.
    assert.equal(outcome, "unverified");
    assert.match(reason, /no verifiable completion record/);
    store.record({
      id: "lattice-polyglot-polyglot-cpu-verification",
      session: "lattice-polyglot",
      kind: "polyglot-cpu-verification",
      outcome,
      reason,
      artifacts,
    });
    assert.equal(store.needsVerification().length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recoverSession writes a per-session manifest without stopping anything", () => {
  const root = mkdtempSync(join(tmpdir(), "lattice-colab-"));
  const stops: string[] = [];
  try {
    const client = {
      ...fakeClient({ "training_metrics.json": "{}", "adapter_model.safetensors": "w" }),
      stop: (session: string) => stops.push(session),
    };
    const store = new ArtifactStore({ root, client });
    const session: ColabSession = {
      name: "lattice-train",
      endpoint: "gpu-t4",
      accelerator: "gpu",
      acceleratorLabel: "T4",
    };
    const records = recoverSession(client, store, session, ["/content/lattice-router-lora"], [
      { kind: "lora-training", metricsFiles: ["training_metrics.json"] },
    ]);
    assert.equal(records.length, 1);
    assert.equal(records[0].session, "lattice-train");
    assert.deepEqual(stops, [], "recovery must never stop a session");
    assert.ok(existsSync(join(root, "lattice-train", "manifest.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("usage over the pause threshold is reported so idle sessions can be stopped", () => {
  const usage: ColabUsage = parseUsage(LIVE_USAGE);
  assert.ok(usage.usageRatePerHour > 0);
  assert.ok(usage.activeAssignments === 2);
});
