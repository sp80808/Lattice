import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildStatsReport, formatStatsReport } from "./index.js";

test("stats groups decisions and only labels objective outcomes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lattice-stats-"));
  const path = join(dir, "run.jsonl");
  const runId = "run-1";
  const events = [
    {
      seq: 1,
      runId,
      at: "2026-01-01T00:00:00Z",
      type: "decision.completed",
      payload: {
        type: "decision.completed",
        round: 1,
        frameId: "f1",
        decisionClass: "next-action",
        question: "q",
        selected: ["a"],
        scores: { a: 0.9 },
        confidence: 0.9,
        identity: { provider: "local", model: "qwen" },
        usage: { totalTokens: 20, latencyMs: 5 },
      },
    },
    {
      seq: 2,
      runId,
      at: "2026-01-01T00:00:01Z",
      type: "decision.completed",
      payload: {
        type: "decision.review.completed",
        round: 1,
        frameId: "f1",
        result: { action: "replace", selected: ["b"] },
      },
    },
    {
      seq: 3,
      runId,
      at: "2026-01-01T00:00:02Z",
      type: "tool.completed",
      payload: {
        tool: "experiment",
        round: 1,
        outcome: {
          status: "success",
          terminal: true,
          evidence: [
            {
              id: "e1",
              kind: "test",
              verified: true,
              source: "npm test",
              summary: "pass",
              createdAt: "2026-01-01T00:00:02Z",
            },
          ],
        },
      },
    },
    {
      seq: 4,
      runId,
      at: "2026-01-01T00:00:03Z",
      type: "decision.completed",
      payload: {
        type: "decision.completed",
        round: 2,
        frameId: "f2",
        decisionClass: "next-action",
        question: "q2",
        selected: ["c"],
        scores: { c: 0.8 },
        confidence: 0.8,
        identity: { provider: "local", model: "qwen" },
        usage: { totalTokens: 10, latencyMs: 3 },
      },
    },
  ];

  await writeFile(path, events.map((event) => JSON.stringify(event)).join("\n"));

  const report = await buildStatsReport([path], dir);
  assert.equal(report.decisions, 2);
  assert.equal(report.outcomeLinked, 1);
  assert.equal(report.unknownOutcomes, 1);
  assert.equal(report.groups.length, 1);

  const group = report.groups[0]!;
  assert.equal(group.verifiedSuccesses, 1);
  assert.equal(group.verifiedSuccessRate, 1);
  assert.equal(group.totalTokens, 30);
  assert.equal(group.humanReviews, 1);
  assert.equal(group.humanOverrides, 1);
  assert.match(formatStatsReport(report), /local\/qwen/);
  assert.match(report.warnings[0] ?? "", /no objective downstream outcome/);
});

test("model-only evidence never labels a decision successful", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lattice-stats-"));
  const path = join(dir, "run.jsonl");
  const events = [
    {
      seq: 1,
      runId: "r",
      at: "2026-01-01T00:00:00Z",
      type: "decision.completed",
      payload: {
        type: "decision.completed",
        round: 1,
        decisionClass: "next-action",
        selected: ["a"],
        scores: { a: 1 },
        confidence: 1,
        identity: { provider: "fixture" },
        usage: { latencyMs: 1 },
      },
    },
    {
      seq: 2,
      runId: "r",
      at: "2026-01-01T00:00:01Z",
      type: "tool.completed",
      payload: {
        tool: "experiment",
        round: 1,
        outcome: {
          status: "success",
          terminal: true,
          evidence: [
            {
              id: "model",
              kind: "model",
              verified: false,
              source: "agent",
              summary: "I fixed it",
              createdAt: "2026-01-01T00:00:01Z",
            },
          ],
        },
      },
    },
  ];

  await writeFile(path, events.map((event) => JSON.stringify(event)).join("\n"));
  const report = await buildStatsReport([path], dir);
  assert.equal(report.outcomeLinked, 0);
  assert.equal(report.groups[0]?.verifiedSuccesses, 0);
});
