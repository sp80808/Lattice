import test from "node:test";
import assert from "node:assert/strict";
import {
  VerseOptimizer,
  type HistoricalFailure,
  type VerseDraftCandidate,
  type VerseTaskEvaluator,
} from "./verse.js";

interface TestHarnessConfig {
  promptCompact: boolean;
  minConfidence: number;
}

test("VerseOptimizer rejects draft that fails to resolve targeted historical failures", async () => {
  const evaluator: VerseTaskEvaluator<TestHarnessConfig> = {
    async evaluateTask(taskId, config) {
      // Always fails
      return false;
    },
  };

  const optimizer = new VerseOptimizer<TestHarnessConfig>({
    baselineConfig: { promptCompact: false, minConfidence: 0.8 },
    evaluator,
    minFailuresResolved: 1,
  });

  const draft: VerseDraftCandidate<TestHarnessConfig> = {
    id: "candidate-1",
    operator: "threshold-tuning",
    hypothesis: "Lower confidence threshold to 0.7",
    config: { promptCompact: false, minConfidence: 0.7 },
  };

  const failures: HistoricalFailure[] = [{ taskId: "task-f1" }, { taskId: "task-f2" }];
  const baselinePasses = new Set<string>(["task-p1"]);

  const decision = await optimizer.evaluateCandidate(draft, failures, ["task-p1"], baselinePasses);

  assert.equal(decision.promoted, false);
  assert.ok(decision.reason.includes("below threshold"));
  assert.equal(optimizer.getActiveConfig().minConfidence, 0.8, "Active config should remain unchanged");

  const stats = optimizer.getOperatorStats();
  assert.equal(stats[0].attempts, 1);
  assert.equal(stats[0].draftsPassed, 0);
  assert.equal(stats[0].promoted, 0);
});

test("VerseOptimizer rejects candidate that introduces regressions on previously passing tasks", async () => {
  const evaluator: VerseTaskEvaluator<TestHarnessConfig> = {
    async evaluateTask(taskId, config) {
      // Resolves task-f1, but breaks task-p1!
      if (taskId === "task-f1") return true;
      if (taskId === "task-p1") return false; // regression!
      if (taskId === "task-p2") return true;
      return false;
    },
  };

  const optimizer = new VerseOptimizer<TestHarnessConfig>({
    baselineConfig: { promptCompact: false, minConfidence: 0.8 },
    evaluator,
  });

  const draft: VerseDraftCandidate<TestHarnessConfig> = {
    id: "candidate-regression",
    operator: "prompt-compaction",
    hypothesis: "Compact instructions to save tokens",
    config: { promptCompact: true, minConfidence: 0.8 },
  };

  const failures: HistoricalFailure[] = [{ taskId: "task-f1" }];
  const baselinePasses = new Set<string>(["task-p1", "task-p2"]);
  const regressionSuite = ["task-p1", "task-p2", "task-f1"];

  const decision = await optimizer.evaluateCandidate(draft, failures, regressionSuite, baselinePasses);

  assert.equal(decision.promoted, false);
  assert.ok(decision.reason.includes("regressions"));
  assert.deepEqual(decision.audit.regressions, ["task-p1"]);
  assert.equal(optimizer.getActiveConfig().promptCompact, false);

  const stats = optimizer.getOperatorStats();
  assert.equal(stats[0].draftsPassed, 1);
  assert.equal(stats[0].promoted, 0);
});

test("VerseOptimizer promotes verified improvement and tracks operator yield", async () => {
  const evaluator: VerseTaskEvaluator<TestHarnessConfig> = {
    async evaluateTask(taskId, config) {
      // Candidate passes task-f1, and preserves task-p1 and task-p2
      if (taskId === "task-f1") return config.promptCompact === true;
      if (taskId === "task-p1" || taskId === "task-p2") return true;
      return false;
    },
  };

  const optimizer = new VerseOptimizer<TestHarnessConfig>({
    baselineConfig: { promptCompact: false, minConfidence: 0.8 },
    evaluator,
  });

  const draft: VerseDraftCandidate<TestHarnessConfig> = {
    id: "candidate-success",
    operator: "prompt-compaction",
    hypothesis: "Compact prompt clarifies task intent",
    config: { promptCompact: true, minConfidence: 0.8 },
  };

  const failures: HistoricalFailure[] = [{ taskId: "task-f1" }];
  const baselinePasses = new Set<string>(["task-p1", "task-p2"]);
  const regressionSuite = ["task-p1", "task-p2", "task-f1"];

  const decision = await optimizer.evaluateCandidate(draft, failures, regressionSuite, baselinePasses);

  assert.equal(decision.promoted, true);
  assert.equal(decision.audit.regressions.length, 0);
  assert.deepEqual(decision.audit.newPasses, ["task-f1"]);
  assert.equal(decision.audit.candidatePasses, 3);
  assert.equal(decision.audit.baselinePasses, 2);
  assert.equal(optimizer.getActiveConfig().promptCompact, true, "Active config should be updated to promoted candidate");

  const stats = optimizer.getOperatorStats();
  assert.equal(stats[0].operator, "prompt-compaction");
  assert.equal(stats[0].attempts, 1);
  assert.equal(stats[0].draftsPassed, 1);
  assert.equal(stats[0].promoted, 1);
  assert.equal(stats[0].yieldRate, 1.0);
});
