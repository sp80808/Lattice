import test from "node:test";
import assert from "node:assert/strict";
import { runAdaptiveSwarm } from "./scheduler.js";
import type { CommandResult, CommandSpec } from "@lattice/execution";

test("runAdaptiveSwarm executes single-file task cleanly through decomposition and verification", async () => {
  const executedCommands: string[] = [];

  const mockRunner = async (spec: CommandSpec): Promise<CommandResult> => {
    const cmdStr = [spec.command, ...(spec.args ?? [])].join(" ");
    executedCommands.push(cmdStr);

    if (spec.command === "bd") {
      const args = spec.args ?? [];
      if (args[0] === "create") {
        return {
          command: "bd",
          args,
          cwd: spec.cwd ?? process.cwd(),
          exitCode: 0,
          signal: null,
          stdout: "Created issue: lat-mock-1",
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
        stdout: "ok",
        stderr: "",
        durationMs: 5,
        timedOut: false,
        outputTruncated: false,
      };
    }

    // Verification command
    return {
      command: spec.command,
      args: spec.args ?? [],
      cwd: spec.cwd ?? process.cwd(),
      exitCode: 0,
      signal: null,
      stdout: "All tests passing",
      stderr: "",
      durationMs: 15,
      timedOut: false,
      outputTruncated: false,
    };
  };

  const result = await runAdaptiveSwarm({
    repoRoot: "/mock/repo",
    task: "Fix formatting in src/types.ts",
    files: ["src/types.ts"],
    verifyCommand: { command: "node", args: ["-e", "process.exit(0)"] },
    beadsEnabled: false,
    runner: mockRunner,
  });

  assert.equal(result.success, true);
  assert.ok(result.dag.nodes.size >= 3);
  assert.equal(result.evaluation.isParallelBeneficial, false, "Single file should prefer single agent");
  assert.ok(result.results.size > 0);
  for (const item of result.results.values()) {
    assert.equal(item.status, "verified");
  }
});

test("runAdaptiveSwarm detects semantic integration failure (Passes Alone Fails Together)", async () => {
  let callCount = 0;

  // Mock where leaf tests pass, but final whole-system integration test fails
  const verifyCommand: CommandSpec = {
    command: "npm",
    args: ["test"],
  };

  const result = await runAdaptiveSwarm({
    repoRoot: "/mock/repo",
    task: "Refactor core API and update consumers",
    files: ["packages/core/src/api.ts", "packages/search/src/consumer.ts"],
    beadsEnabled: false,
    // Custom task executor that simulates integration failure
    executor: async (task) => {
      if (task.role === "integration") {
        return {
          taskId: task.id,
          status: "failed",
          evidenceIds: [],
          changedFiles: [],
          unresolvedDependencies: [],
          verificationResults: ["Integration test failed: incompatible API contract between core and search"],
          durationMs: 50,
          error: "Semantic integration regression detected: consumers broken by core changes",
        };
      }
      return {
        taskId: task.id,
        status: "verified",
        evidenceIds: ["ev:test"],
        changedFiles: task.writeScope,
        unresolvedDependencies: [],
        verificationResults: ["Leaf tests passed"],
        durationMs: 25,
      };
    },
  });

  assert.equal(result.success, false, "Must fail when whole-system integration fails");
  const integrationResult = Array.from(result.results.values()).find(
    (r) => r.error && r.error.includes("Semantic integration regression")
  );
  assert.ok(integrationResult, "Must capture semantic integration error");
});

test("runAdaptiveSwarm isolates worker failures without crashing sibling tasks", async () => {
  const result = await runAdaptiveSwarm({
    repoRoot: "/mock/repo",
    task: "Implement independent features A and B",
    files: ["packages/a/src/index.ts", "packages/b/src/index.ts"],
    beadsEnabled: false,
    executor: async (task) => {
      // Feature A fails, but Research and Feature B pass
      if (task.writeScope.includes("packages/a/src/index.ts")) {
        return {
          taskId: task.id,
          status: "failed",
          evidenceIds: [],
          changedFiles: [],
          unresolvedDependencies: [],
          verificationResults: [],
          durationMs: 20,
          error: "Feature A syntax error",
        };
      }
      return {
        taskId: task.id,
        status: "verified",
        evidenceIds: ["ev:success"],
        changedFiles: task.writeScope,
        unresolvedDependencies: [],
        verificationResults: ["OK"],
        durationMs: 20,
      };
    },
  });

  const results = Array.from(result.results.values());
  // console.log("Test 3 results:", results.map(r => ({ taskId: r.taskId, status: r.status, err: r.error })));
  const failedTask = results.find((r) => r.status === "failed");
  const verifiedTasks = results.filter((r) => r.status === "verified");

  assert.ok(failedTask, "Failed task must be recorded");
  assert.ok(verifiedTasks.length >= 2, "Sibling tasks must succeed and retain evidence");
});
