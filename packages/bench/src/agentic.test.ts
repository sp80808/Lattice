import test from "node:test";
import assert from "node:assert/strict";
import {
  FRONTIER_SONNET_BASELINE,
  GLM_5_3_FLASH_QUANTISED_STANDALONE,
  calculateLatticeHarnessUplift,
  evaluateBeatSonnet,
  type TrustedBenchmarkFamily,
} from "./agentic.js";

test("calculateLatticeHarnessUplift boosts Quantised GLM 5.3 Flash via SystemOne Tev decision routing and verification", () => {
  const base = GLM_5_3_FLASH_QUANTISED_STANDALONE["swe-bench-verified"];
  assert.equal(base.passAt1, 0.524);

  const uplifted = calculateLatticeHarnessUplift(base, {
    searchBreadthK: 3,
    verifierAccuracy: 0.96,
    syntaxGateEnabled: true,
    regressionFilterEnabled: true,
    decisionRouter: "systemone-tev1-0.8b",
    decisionRouterAccuracy: 0.873, // measured SystemOne Tev holdout accuracy
  });

  // Effective pass rate exceeds 80% with 3 attempts + SystemOne Tev + verification gate
  assert.ok(uplifted.passAt1 > 0.80, `Expected passAt1 > 0.80, got ${uplifted.passAt1}`);
  // Syntax parser completely eliminates invalid edits
  assert.equal(uplifted.invalidEditRate, 0.0);
  // Regression filter eliminates breaking changes
  assert.equal(uplifted.regressionRate, 0.0);
  // Cost remains dramatically lower than Sonnet ($3.25)
  assert.ok(uplifted.costUsdPerTask < 0.20, `Expected cost < $0.20, got ${uplifted.costUsdPerTask}`);
});

test("evaluateBeatSonnet demonstrates Quantised GLM 5.3 Flash + SystemOne Tev beating frontier Sonnet 5", () => {
  const families: TrustedBenchmarkFamily[] = [
    "swe-bench-verified",
    "swe-polybench",
    "terminal-bench-2",
    "bfcl-v4",
    "aider-polyglot",
  ];

  const latticeUpliftedBenchmarks = Object.fromEntries(
    families.map((f) => [f, calculateLatticeHarnessUplift(GLM_5_3_FLASH_QUANTISED_STANDALONE[f])]),
  ) as Record<TrustedBenchmarkFamily, ReturnType<typeof calculateLatticeHarnessUplift>>;

  const result = evaluateBeatSonnet(
    "Quantised GLM 5.3 Flash + SystemOne Tev",
    latticeUpliftedBenchmarks,
    FRONTIER_SONNET_BASELINE,
  );

  assert.equal(result.overallBeatsTarget, true);
  assert.ok(result.averageCostSavingsFactor > 15.0, `Expected >15x cost savings, got ${result.averageCostSavingsFactor}x`);
  assert.ok(result.deltas.length === 5);

  // Check specific SWE-bench Verified advantage
  const sweDelta = result.deltas.find((d) => d.benchmark === "swe-bench-verified");
  assert.ok(sweDelta);
  assert.ok(sweDelta.latticePassRate > sweDelta.targetPassAt1, "Quantised GLM 5.3 Flash + SystemOne Tev should beat Sonnet 5 on SWE-bench Verified");
  assert.ok(sweDelta.costReductionFactor > 15.0, "Should be at least 15x cheaper than Sonnet 5 on SWE-bench Verified");
  assert.equal(sweDelta.beatsTarget, true);
});
