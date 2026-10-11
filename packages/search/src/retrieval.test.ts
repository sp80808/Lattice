import test from "node:test";
import assert from "node:assert/strict";
import type { DecisionProvider, DecisionRequest, DecisionResult } from "@lattice/protocol";
import {
  Bm25SkillRetriever,
  SkillRetrievalEngine,
  tokenize,
  type SkillDefinition,
} from "./retrieval.js";

const sampleSkills: SkillDefinition[] = [
  {
    id: "run-test",
    name: "Run Tests",
    description: "Executes unit and integration test suites using vitest or cargo test.",
    keywords: ["test", "verify", "assert", "spec"],
    riskLevel: "low",
  },
  {
    id: "git-status",
    name: "Git Status",
    description: "Checks working tree status, staged files and diffs.",
    keywords: ["git", "status", "diff", "unstaged"],
    riskLevel: "low",
  },
  {
    id: "git-commit",
    name: "Git Commit",
    description: "Records changes to repository with a commit message.",
    keywords: ["git", "commit", "save", "record"],
    riskLevel: "medium",
  },
  {
    id: "drop-database",
    name: "Drop Database",
    description: "Completely drops and resets local development databases.",
    keywords: ["database", "drop", "purge", "reset"],
    riskLevel: "high",
  },
];

test("tokenize handles casing, punctuation, and hyphens", () => {
  const tokens = tokenize("Run_test with k1=1.2 and b-score!");
  assert.ok(tokens.includes("run"));
  assert.ok(tokens.includes("test"));
  assert.ok(tokens.includes("score"));
});

test("Bm25SkillRetriever retrieves ranked skills by relevance", () => {
  const retriever = new Bm25SkillRetriever(sampleSkills);
  const results = retriever.retrieve("execute test specs");

  assert.ok(results.length > 0);
  assert.equal(results[0].skill.id, "run-test");
  assert.ok(results[0].score > 0);
});

test("SkillRetrievalEngine routes deterministically on confident match", async () => {
  let modelInvoked = false;
  const mockProvider: DecisionProvider = {
    async decide(): Promise<DecisionResult> {
      modelInvoked = true;
      return {
        selected: ["run-test"],
        scores: {},
        identity: { provider: "mock", model: "mock" },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, latencyMs: 1 },
      };
    },
  };

  const engine = new SkillRetrievalEngine(sampleSkills);
  const result = await engine.route("run vitest unit tests", {
    decisionProvider: mockProvider,
    minConfidence: 0.5,
    minMargin: 0.2,
  });

  assert.equal(result.source, "deterministic");
  assert.equal(result.selected?.id, "run-test");
  assert.equal(modelInvoked, false, "Decision provider should not be called for confident deterministic match");
});

test("SkillRetrievalEngine escalates to model when margin is tight", async () => {
  let modelInvoked = false;
  const mockProvider: DecisionProvider = {
    async decide(req: DecisionRequest): Promise<DecisionResult> {
      modelInvoked = true;
      assert.ok(req.choices.length > 1);
      return {
        selected: ["git-commit"],
        scores: {},
        identity: { provider: "mock", model: "mock" },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.0001, latencyMs: 2 },
      };
    },
  };

  const engine = new SkillRetrievalEngine(sampleSkills);
  // Query "git" matches both git-status and git-commit similarly
  const result = await engine.route("git", {
    decisionProvider: mockProvider,
    minMargin: 5.0, // Force margin check to escalate
  });

  assert.equal(result.source, "model-escalated");
  assert.equal(result.selected?.id, "git-commit");
  assert.equal(modelInvoked, true, "Decision provider must be invoked when margin is below threshold");
});

test("SkillRetrievalEngine escalates to model for high-risk skills even with high score", async () => {
  let modelInvoked = false;
  const mockProvider: DecisionProvider = {
    async decide(): Promise<DecisionResult> {
      modelInvoked = true;
      return {
        selected: ["drop-database"],
        scores: {},
        identity: { provider: "mock", model: "mock" },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.0001, latencyMs: 2 },
      };
    },
  };

  const engine = new SkillRetrievalEngine(sampleSkills);
  const result = await engine.route("drop database reset", {
    decisionProvider: mockProvider,
    forceModelIfRiskHigh: true,
  });

  assert.equal(result.source, "model-escalated");
  assert.equal(result.selected?.id, "drop-database");
  assert.equal(modelInvoked, true, "High risk actions must escalate to decision provider");
});

test("SkillRetrievalEngine handles unknown queries with fallback", async () => {
  const engine = new SkillRetrievalEngine(sampleSkills);
  const result = await engine.route("xyzqwerty nonexistent query");

  assert.equal(result.source, "fallback");
  assert.equal(result.selected, undefined);
  assert.equal(result.candidates.length, 0);
});
