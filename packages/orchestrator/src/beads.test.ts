import test from "node:test";
import assert from "node:assert/strict";
import { BeadsCoordinator, parseBeadsIdFromOutput } from "./beads.js";
import type { TaskDAG, TaskNode } from "./types.js";
import type { CommandResult, CommandSpec } from "@lattice/execution";

test("parseBeadsIdFromOutput extracts issue ID from bd output", () => {
  const output1 = "Created issue: lat-xyz (Implement feature)";
  assert.equal(parseBeadsIdFromOutput(output1), "lat-xyz");

  const output2 = "✓ lat-123 · [● P2 · OPEN]";
  assert.equal(parseBeadsIdFromOutput(output2), "lat-123");

  const output3 = "lat-abc";
  assert.equal(parseBeadsIdFromOutput(output3), "lat-abc");
});

test("BeadsCoordinator creates issues and links dependencies via command runner", async () => {
  const executedCommands: CommandSpec[] = [];

  const mockRunner = async (spec: CommandSpec): Promise<CommandResult> => {
    executedCommands.push(spec);
    const args = spec.args ?? [];

    if (args[0] === "create") {
      const isFeature = args.some((a) => a.includes("type=feature"));
      const id = isFeature ? "lat-epic-1" : `lat-task-${executedCommands.length}`;
      return {
        command: "bd",
        args,
        cwd: spec.cwd ?? process.cwd(),
        exitCode: 0,
        signal: null,
        stdout: `Created issue: ${id}`,
        stderr: "",
        durationMs: 10,
        timedOut: false,
        outputTruncated: false,
      };
    }

    if (args[0] === "dep" && args[1] === "add") {
      return {
        command: "bd",
        args,
        cwd: spec.cwd ?? process.cwd(),
        exitCode: 0,
        signal: null,
        stdout: `Linked dependency: ${args[2]} depends on ${args[3]}`,
        stderr: "",
        durationMs: 5,
        timedOut: false,
        outputTruncated: false,
      };
    }

    if (args[0] === "update" && args.includes("--claim")) {
      return {
        command: "bd",
        args,
        cwd: spec.cwd ?? process.cwd(),
        exitCode: 0,
        signal: null,
        stdout: `Claimed issue ${args[1]}`,
        stderr: "",
        durationMs: 5,
        timedOut: false,
        outputTruncated: false,
      };
    }

    if (args[0] === "ready") {
      return {
        command: "bd",
        args,
        cwd: spec.cwd ?? process.cwd(),
        exitCode: 0,
        signal: null,
        stdout: "○ lat-task-1 ● P2 Initial task\n○ lat-task-2 ● P2 Ready task",
        stderr: "",
        durationMs: 5,
        timedOut: false,
        outputTruncated: false,
      };
    }

    if (args[0] === "close") {
      return {
        command: "bd",
        args,
        cwd: spec.cwd ?? process.cwd(),
        exitCode: 0,
        signal: null,
        stdout: `Closed ${args[1]}`,
        stderr: "",
        durationMs: 5,
        timedOut: false,
        outputTruncated: false,
      };
    }

    return {
      command: "bd",
      args,
      cwd: spec.cwd ?? process.cwd(),
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      durationMs: 5,
      timedOut: false,
      outputTruncated: false,
    };
  };

  const coordinator = new BeadsCoordinator({
    repoRoot: "/mock/repo",
    runner: mockRunner,
  });

  const epicId = await coordinator.createEpic("Swarm Epic", "High-level objective");
  assert.equal(epicId, "lat-epic-1");

  const nodes = new Map<string, TaskNode>();
  nodes.set("node-1", {
    id: "node-1",
    title: "Inspect code",
    objective: "Inspect",
    role: "research",
    dependencies: [],
    readScope: [],
    writeScope: [],
    acceptanceCriteria: ["Inspected"],
    timeoutMs: 60_000,
    status: "pending",
  });
  nodes.set("node-2", {
    id: "node-2",
    title: "Write patch",
    objective: "Patch",
    role: "implementation",
    dependencies: ["node-1"],
    readScope: [],
    writeScope: ["foo.ts"],
    acceptanceCriteria: ["Patched"],
    timeoutMs: 60_000,
    status: "pending",
  });

  const dag: TaskDAG = {
    id: "test-dag",
    task: "Test swarm task",
    nodes,
    edges: [{ from: "node-1", to: "node-2" }],
  };

  const mapping = await coordinator.syncTaskDag(dag, epicId);
  assert.equal(mapping.size, 2);
  assert.ok(dag.nodes.get("node-1")!.beadsId);
  assert.ok(dag.nodes.get("node-2")!.beadsId);

  // Check that bd dep add was called
  const depCalls = executedCommands.filter(
    (c) => c.args?.[0] === "dep" && c.args?.[1] === "add"
  );
  assert.equal(depCalls.length, 1);

  // Check claim
  const beadsId1 = dag.nodes.get("node-1")!.beadsId!;
  const claimed = await coordinator.claimTask(beadsId1);
  assert.equal(claimed, true);

  // Check ready
  const ready = await coordinator.queryReadyTasks();
  assert.deepEqual(ready, ["lat-task-1", "lat-task-2"]);

  // Check close
  await coordinator.completeTask(beadsId1, "Unit tests passed");
  const closeCalls = executedCommands.filter((c) => c.args?.[0] === "close");
  assert.equal(closeCalls.length, 1);
});
