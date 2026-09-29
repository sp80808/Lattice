import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mineLedger } from "./index.js";

function frameEvent(runId: string, round: number, id: string) {
  return {
    seq: round * 10,
    runId,
    at: "x",
    type: "decision.requested",
    payload: {
      round,
      event: {
        type: "decision.framed",
        round,
        frame: {
          id,
          class: "next-action",
          objective: "fix parser",
          question: "Which next action?",
          criteria: ["verified progress"],
          evidenceIds: ["e0"],
          choices: [
            { id: "a", label: "Inspect state", detail: "inspect parser state" },
            { id: "b", label: "Apply targeted fix", detail: "apply parser fix" },
            { id: "__none__", label: "none" },
          ],
          audit: [],
        },
      },
    },
  };
}

function decisionEvent(runId: string, round: number, id: string, selected: string) {
  return {
    seq: round * 10 + 1,
    runId,
    at: "x",
    type: "decision.completed",
    payload: {
      type: "decision.completed",
      round,
      frameId: id,
      decisionClass: "next-action",
      question: "Which next action?",
      selected: [selected],
      scores: { [selected]: 1 },
      identity: { provider: "fixture" },
      usage: { latencyMs: 1 },
    },
  };
}

function outcomeEvent(runId: string, round: number, success: boolean) {
  return {
    seq: round * 10 + 2,
    runId,
    at: "x",
    type: "tool.completed",
    payload: {
      tool: "experiment",
      round,
      outcome: {
        candidateId: success ? "b" : "a",
        status: success ? "success" : "failure",
        terminal: success,
        evidence: [{
          id: `e-${round}`,
          kind: "test",
          verified: success,
          source: "test",
          summary: success ? "pass" : "fail",
          createdAt: "x",
        }],
      },
    },
  };
}

test("mining proposes stable rules and failure-fix tiles without trusting them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lattice-mine-"));

  for (let runIndex = 0; runIndex < 3; runIndex++) {
    const runId = `r${runIndex}`;
    const path = join(dir, `${runId}.jsonl`);
    const events = [
      { seq: 1, runId, at: "x", type: "run.started", payload: { task: "fix parser", cwd: dir } },
      frameEvent(runId, 1, `f1-${runIndex}`),
      decisionEvent(runId, 1, `f1-${runIndex}`, "a"),
      outcomeEvent(runId, 1, false),
      frameEvent(runId, 2, `f2-${runIndex}`),
      decisionEvent(runId, 2, `f2-${runIndex}`, "b"),
      outcomeEvent(runId, 2, true),
    ];
    await writeFile(path, events.map((event) => JSON.stringify(event)).join("\n"));
  }

  const report = await mineLedger([dir], {
    minRuleSupport: 3,
    minRuleSuccessRate: 1,
    minDominantShare: 1,
  });

  assert.ok(report.rules.some((rule) => rule.action.selectLabel === "Apply targeted fix"));
  assert.ok(report.rules.every((rule) => rule.state === "inferred"));
  assert.ok(report.tiles.length >= 1);
  assert.equal(report.tiles[0]?.state, "inferred");
  assert.equal(report.tiles[0]?.promotion.automatic, false);
});
