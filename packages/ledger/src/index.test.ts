import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  effectiveSelected,
  loadLedger,
  objectiveOutcome,
} from "./index.js";

test("ledger normalizes frames decisions reviews and objective outcomes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lattice-ledger-"));
  const path = join(dir, "run.jsonl");
  const events = [
    {
      seq: 1, runId: "r", at: "x", type: "run.started",
      payload: { task: "fix parser", cwd: dir },
    },
    {
      seq: 2, runId: "r", at: "x", type: "decision.requested",
      payload: {
        round: 1,
        event: {
          type: "decision.framed",
          round: 1,
          frame: {
            id: "f",
            class: "next-action",
            objective: "fix parser",
            question: "which action",
            criteria: ["verified progress"],
            evidenceIds: ["e0"],
            choices: [
              { id: "a", label: "Inspect" },
              { id: "b", label: "Reproduce" },
            ],
            audit: [],
          },
        },
      },
    },
    {
      seq: 3, runId: "r", at: "x", type: "decision.completed",
      payload: {
        type: "decision.completed",
        round: 1,
        frameId: "f",
        decisionClass: "next-action",
        selected: ["a"],
        scores: { a: 0.8, b: 0.2 },
        identity: { provider: "p", model: "m" },
        usage: { latencyMs: 2 },
      },
    },
    {
      seq: 4, runId: "r", at: "x", type: "decision.completed",
      payload: {
        type: "decision.review.completed",
        round: 1,
        frameId: "f",
        result: { action: "replace", selected: ["b"] },
      },
    },
    {
      seq: 5, runId: "r", at: "x", type: "tool.completed",
      payload: {
        tool: "experiment",
        round: 1,
        outcome: {
          candidateId: "b",
          status: "success",
          terminal: true,
          evidence: [{
            id: "e1",
            kind: "test",
            verified: true,
            source: "test",
            summary: "pass",
            createdAt: "x",
          }],
        },
      },
    },
  ];
  await writeFile(path, events.map((event) => JSON.stringify(event)).join("\n"));

  const [run] = await loadLedger([path], dir);
  assert.ok(run);
  assert.equal(run.task, "fix parser");
  assert.equal(run.frames[0]?.id, "f");
  assert.deepEqual(effectiveSelected(run, run.decisions[0]!), ["b"]);
  assert.deepEqual(objectiveOutcome(run, 1), {
    linked: true,
    success: true,
    experiments: run.experiments,
  });
});
