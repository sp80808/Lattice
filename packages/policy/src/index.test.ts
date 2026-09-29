import assert from "node:assert/strict";
import test from "node:test";
import type { LedgerRun } from "@lattice/ledger";
import { simulatePolicy } from "./index.js";

function run(): LedgerRun {
  return {
    sourceFile: "fixture",
    runId: "run-1",
    task: "fix parser",
    frames: [
      {
        round: 1,
        id: "f1",
        decisionClass: "next-action",
        question: "q",
        criteria: [],
        evidenceIds: [],
        choices: [
          { id: "a", label: "A", detail: "estimated cost: low" },
          { id: "b", label: "B", detail: "estimated cost: low" },
        ],
        audit: [],
      },
      {
        round: 2,
        id: "f2",
        decisionClass: "next-action",
        question: "q",
        criteria: [],
        evidenceIds: [],
        choices: [{ id: "c", label: "C", detail: "estimated cost: low" }],
        audit: [],
      },
    ],
    decisions: [
      {
        round: 1,
        frameId: "f1",
        decisionClass: "next-action",
        selected: ["a", "b"],
        scores: { a: 0.6, b: 0.4 },
        confidence: 0.8,
        entropy: 0.5,
        identity: { provider: "fixture" },
        usage: { totalTokens: 10, costUsd: 0.01, latencyMs: 2 },
      },
      {
        round: 2,
        frameId: "f2",
        decisionClass: "next-action",
        selected: ["c"],
        scores: { c: 1 },
        confidence: 0.9,
        entropy: 0,
        identity: { provider: "fixture" },
        usage: { totalTokens: 10, costUsd: 0.01, latencyMs: 2 },
      },
    ],
    reviews: [],
    experiments: [
      {
        round: 1,
        candidateId: "a",
        status: "failure",
        terminal: false,
        evidence: [{
          id: "ea",
          kind: "test",
          verified: false,
          source: "test",
          summary: "fail",
          createdAt: "x",
        }],
      },
      {
        round: 1,
        candidateId: "b",
        status: "failure",
        terminal: false,
        evidence: [{
          id: "eb",
          kind: "test",
          verified: false,
          source: "test",
          summary: "fail",
          createdAt: "x",
        }],
      },
      {
        round: 2,
        candidateId: "c",
        status: "success",
        terminal: true,
        evidence: [{
          id: "ec",
          kind: "test",
          verified: true,
          source: "test",
          summary: "pass",
          createdAt: "x",
        }],
      },
    ],
  };
}

test("policy replay can safely simulate fewer rounds and smaller top-k", () => {
  const report = simulatePolicy(
    [run()],
    {
      autonomy: { mode: "autopilot" },
      search: { maxRounds: 1, topK: 1 },
    },
    0,
  );

  assert.equal(report.train.comparableRuns, 1);
  assert.equal(report.train.baseline.verifiedSuccesses, 1);
  assert.equal(report.train.candidate.verifiedSuccesses, 0);
  assert.equal(report.train.candidate.decisionCalls, 1);
  assert.equal(report.train.candidate.experiments, 1);
});

test("policy replay marks new human review as unsupported", () => {
  const report = simulatePolicy(
    [run()],
    {
      autonomy: { mode: "manual" },
    },
    0,
  );

  assert.equal(report.train.comparableRuns, 0);
  assert.equal(report.train.unsupportedRuns, 1);
  assert.ok(
    Object.keys(report.train.unsupportedReasons).some((reason) =>
      reason.includes("human review"),
    ),
  );
});

test("policy replay refuses top-k expansion beyond recorded choices", () => {
  const fixture = run();
  fixture.decisions[0]!.selected = ["a"];
  fixture.experiments = fixture.experiments.filter(
    (item) => item.round !== 1 || item.candidateId === "a",
  );

  const report = simulatePolicy(
    [fixture],
    {
      autonomy: { mode: "autopilot" },
      search: { topK: 2 },
    },
    0,
  );

  assert.equal(report.train.comparableRuns, 0);
  assert.ok(
    Object.keys(report.train.unsupportedReasons).some((reason) =>
      reason.includes("topK"),
    ),
  );
});
