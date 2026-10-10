import assert from "node:assert/strict";
import test from "node:test";
import {
  IncompatibleTransportError,
  ModelNotAvailableError,
  ModelRegistry,
  NoEligibleTargetError,
  authReadiness,
  discoverOllamaModels,
  registerTargetsFromLiveOllama,
  resolveTarget,
  targetSupportsRole,
  transportSupportsRole,
  type OllamaModelReport,
  type TargetSpec,
} from "./registry.js";

/** The models actually installed on this machine's Ollama endpoint. */
const LIVE: OllamaModelReport[] = [
  {
    name: "tev1:0.8b",
    model: "tev1:0.8b",
    capabilities: ["decision"],
    parameterSize: "752M",
    family: "qwen3_5",
    format: "safetensors",
    runner: "mlx",
  },
  {
    name: "qwen2.5-coder:1.5b",
    model: "qwen2.5-coder:1.5b",
    capabilities: ["completion", "tools", "insert"],
    parameterSize: "1.5B",
    family: "qwen2",
    format: "gguf",
  },
  {
    name: "qwen3:1.7b",
    model: "qwen3:1.7b",
    capabilities: ["completion", "tools", "thinking"],
    parameterSize: "2.0B",
    family: "qwen3",
    format: "gguf",
  },
];

test("a decision-capable model selects the systemone choice transport", () => {
  const registry = new ModelRegistry();
  const [tev1] = registry.registerDiscoveredOllama("http://127.0.0.1:11434/v1", "decision", LIVE);
  assert.equal(tev1.modelId, "tev1:0.8b");
  assert.equal(tev1.transport, "systemone-choice");
  assert.equal(tev1.capabilities.includes("decision"), true);
});

test("a completion-only model is never given the systemone choice transport", () => {
  const registry = new ModelRegistry();
  const targets = registry.registerDiscoveredOllama("http://127.0.0.1:11434/v1", "decision", LIVE);
  const chatty = targets.filter((t) => t.modelId !== "tev1:0.8b");
  assert.ok(chatty.length >= 2);
  for (const target of chatty) {
    assert.equal(target.transport, "ollama-openai-compatible");
    // A chat transport cannot carry a typed choice decision.
    assert.equal(targetSupportsRole(target, "decision"), false);
  }
});

test("the recorded qwen3-coder default is rejected before execution when absent", () => {
  const registry = new ModelRegistry();
  registry.registerDiscoveredOllama("http://127.0.0.1:11434/v1", "generator", LIVE);
  registry.registerDiscoveredOllama("http://127.0.0.1:11434/v1", "decision", LIVE);
  assert.throws(
    () => resolveTarget(registry, "qwen3-coder", "generator"),
    (error: unknown) => {
      assert.ok(error instanceof ModelNotAvailableError);
      assert.match(error.message, /qwen3-coder/);
      assert.match(error.message, /never invents or downloads model IDs/);
      assert.equal(error.searched.length, 2);
      return true;
    },
  );
});

test("a model present under the wrong role fails as a transport mismatch, not a substitution", () => {
  const registry = new ModelRegistry();
  registry.registerDiscoveredOllama("http://127.0.0.1:11434/v1", "decision", LIVE);
  const tev1 = registry.findByModelId("tev1:0.8b")[0];
  // tev1:0.8b only declares "decision"; asking it to generate code is refused.
  assert.throws(() => resolveTarget(registry, "tev1:0.8b", "generator"), IncompatibleTransportError);
  assert.equal(tev1.capabilities.includes("completion"), false);
});

test("selection fails closed with an actionable reason when nothing is eligible", () => {
  const registry = new ModelRegistry();
  registry.register({
    provider: "ollama",
    modelId: "some-model",
    transport: "ollama-openai-compatible",
    endpoint: "http://127.0.0.1:11434/v1",
    role: "decision",
    capabilities: ["completion"],
    availability: "available",
    auth: "not-required",
  });
  assert.throws(
    () => registry.select("decision"),
    (error: unknown) => {
      assert.ok(error instanceof NoEligibleTargetError);
      assert.match(error.rejected[0].reason, /cannot carry role decision/);
      return true;
    },
  );
});

test("unreachable, disabled, unauthorised and exhausted targets are excluded with reasons", () => {
  const base: Omit<TargetSpec, "id" | "availability" | "auth" | "modelId"> = {
    provider: "ollama",
    transport: "ollama-openai-compatible",
    endpoint: "http://127.0.0.1:11434/v1",
    role: "generator",
    capabilities: ["completion"],
  };
  const registry = new ModelRegistry();
  registry.register({ ...base, modelId: "m-unreachable", availability: "unreachable" });
  registry.register({ ...base, modelId: "m-disabled", availability: "disabled" });
  registry.register({ ...base, modelId: "m-noauth", auth: "missing-credential" });
  registry.register({ ...base, modelId: "m-expired", auth: "expired" });
  registry.register({ ...base, modelId: "m-exhausted", availability: "exhausted" });
  try {
    registry.select("generator");
    assert.fail("expected selection to fail closed");
  } catch (error) {
    assert.ok(error instanceof NoEligibleTargetError);
    const reasons = error.rejected.map((r) => r.reason).join(" | ");
    for (const fragment of ["unreachable", "disabled", "missing-credential", "expired", "exhausted"]) {
      assert.match(reasons, new RegExp(fragment));
    }
  }
});

test("every dispatch is audited and never substitutes a different model", () => {
  const registry = new ModelRegistry();
  const registered = registry.registerDiscoveredOllama("http://127.0.0.1:11434/v1", "generator", LIVE);
  const chosen = registry.select("generator");
  const audit = registry.auditTrail();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].modelId, chosen.modelId);
  assert.ok(registered.some((t) => t.id === chosen.id));
  // A second select re-records; the model identity is still exact.
  registry.select("generator");
  assert.equal(registry.auditTrail()[1].modelId, chosen.modelId);
});

test("verified performance history breaks ties toward the verified model", () => {
  const registry = new ModelRegistry();
  const slow = registry.register({
    provider: "ollama", modelId: "slow", transport: "ollama-openai-compatible",
    endpoint: "e", role: "generator", capabilities: ["completion"],
    availability: "available", auth: "not-required",
  });
  const proven = registry.register({
    provider: "ollama", modelId: "proven", transport: "ollama-openai-compatible",
    endpoint: "e", role: "generator", capabilities: ["completion"],
    availability: "available", auth: "not-required",
  });
  for (let i = 0; i < 25; i++) {
    registry.recordPerformance(slow.id, { at: new Date().toISOString(), latencyMs: 900, ok: true });
    registry.recordPerformance(proven.id, {
      at: new Date().toISOString(), latencyMs: 100, ok: true, verifiedOutcome: true,
    });
  }
  assert.equal(registry.select("generator").modelId, "proven");
  assert.equal(slow.history.samples, 25);
  assert.equal(proven.history.verifiedSuccessRate, 1);
});

test("transport capability matrix matches the observed Ollama behaviour", () => {
  assert.equal(transportSupportsRole("decision", "systemone-choice"), true);
  assert.equal(transportSupportsRole("decision", "ollama-openai-compatible"), false);
  assert.equal(transportSupportsRole("generator", "systemone-choice"), false);
  assert.equal(transportSupportsRole("generator", "ollama-openai-compatible"), true);
  assert.equal(transportSupportsRole("verifier", "colab-remote-batch"), true);
  assert.equal(transportSupportsRole("coding-worker", "cli-worker"), true);
});

test("discovery returns only models the endpoint actually listed", async () => {
  const reports = await discoverOllamaModels("http://127.0.0.1:11434/v1", async () =>
    new Response(
      JSON.stringify({
        models: [
          { name: "tev1:0.8b", model: "tev1:0.8b", capabilities: ["decision"], size: 796578566 },
          { name: "qwen3:1.7b", model: "qwen3:1.7b", capabilities: ["completion", "thinking"] },
        ],
      }),
    ),
  );
  assert.deepEqual(
    reports.map((r) => r.name),
    ["tev1:0.8b", "qwen3:1.7b"],
  );
  assert.equal(reports[0].capabilities.includes("decision"), true);
});

test("discovery never invents a model when the endpoint is unreachable", async () => {
  const reports = await discoverOllamaModels("http://127.0.0.1:11434/v1", async () => {
    throw new TypeError("fetch failed");
  });
  assert.deepEqual(reports, []);
});

test("registering discovered targets against a live endpoint yields one verified decision target", async () => {
  const registry = await registerTargetsFromLiveOllama("http://127.0.0.1:11434/v1", fetch, {
    roles: ["decision", "generator"],
  });
  const decision = registry.select("decision");
  assert.equal(decision.modelId, "tev1:0.8b");
  assert.equal(decision.transport, "systemone-choice");
  assert.equal(decision.availability, "available");
  assert.equal(decision.auth, "not-required");
  assert.match(decision.provenance ?? "", /api\/tags/);

  const generator = registry.select("generator");
  assert.notEqual(generator.modelId, "tev1:0.8b");
  assert.equal(generator.capabilities.includes("completion"), true);

  // The historical default is still refused: it is not installed.
  assert.throws(() => resolveTarget(registry, "qwen3-coder", "generator"), ModelNotAvailableError);
});

test("auth readiness distinguishes a named-but-absent credential from a missing requirement", () => {
  assert.equal(authReadiness(undefined, {}), "not-required");
  assert.equal(authReadiness("OPENCODE_API_KEY", {}), "missing-credential");
  assert.equal(authReadiness("OPENCODE_API_KEY", { OPENCODE_API_KEY: "" }), "missing-credential");
  assert.equal(authReadiness("OPENCODE_API_KEY", { OPENCODE_API_KEY: "sk-live" }), "ready");
});
