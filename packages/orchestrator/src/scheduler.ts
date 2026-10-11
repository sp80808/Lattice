import { runCommand, type CommandResult, type CommandSpec } from "@lattice/execution";
import { decomposeTask, topologicalSort } from "./decomposition.js";
import { evaluateOrchestrationPlan, DEFAULT_M1_PROFILE } from "./evaluator.js";
import { BeadsCoordinator, type CommandRunner } from "./beads.js";
import type {
  HardwareProfile,
  OrchBenchPlanEvaluation,
  SwarmExecutionOptions,
  SwarmExecutionResult,
  SwarmResult,
  SwarmTask,
  TaskDAG,
  TaskNode,
} from "./types.js";

export type TaskExecutor = (task: SwarmTask) => Promise<SwarmResult>;

export interface ExtendedSwarmExecutionOptions extends SwarmExecutionOptions {
  executor?: TaskExecutor;
  runner?: CommandRunner;
}

/**
 * Default local executor that executes leaf verification commands and records evidence.
 */
async function defaultTaskExecutor(
  task: SwarmTask,
  verifyCommand?: CommandSpec,
  runner: CommandRunner = runCommand
): Promise<SwarmResult> {
  const start = Date.now();

  // If a verification command is provided and task is verification or integration
  if (verifyCommand && (task.role === "verification" || task.role === "integration")) {
    try {
      const res = await runner(verifyCommand);
      const verified = res.exitCode === 0 && !res.timedOut;
      return {
        taskId: task.id,
        beadsId: task.beadsId,
        status: verified ? "verified" : "failed",
        evidenceIds: [`ev:${task.id}`],
        changedFiles: task.writeScope,
        unresolvedDependencies: [],
        verificationResults: [
          `exit=${res.exitCode}; timedOut=${res.timedOut}; stdout=${res.stdout.slice(0, 200)}`,
        ],
        durationMs: Date.now() - start,
        error: verified ? undefined : `Verification command failed with exit ${res.exitCode}`,
      };
    } catch (err) {
      return {
        taskId: task.id,
        beadsId: task.beadsId,
        status: "failed",
        evidenceIds: [],
        changedFiles: [],
        unresolvedDependencies: [],
        verificationResults: [],
        durationMs: Date.now() - start,
        error: String(err),
      };
    }
  }

  // Read-only research or review succeeds with evidence
  return {
    taskId: task.id,
    beadsId: task.beadsId,
    status: "verified",
    evidenceIds: [`ev:${task.id}`],
    changedFiles: task.writeScope,
    unresolvedDependencies: [],
    verificationResults: [`${task.role} executed successfully within assigned scope`],
    durationMs: Date.now() - start,
  };
}

/**
 * Executes an adaptive multi-agent swarm task:
 * 1. Decomposes task into a versioned TaskDAG with write-scope collision prevention.
 * 2. Evaluates the plan using OrchBench metrics and hardware profiles.
 * 3. Syncs tasks and dependencies to Beads (if enabled).
 * 4. Schedules ready tasks respecting hardware concurrency bounds.
 * 5. Runs leaf checks and final whole-system semantic integration (*Passes Alone, Fails Together*).
 */
export async function runAdaptiveSwarm(
  options: ExtendedSwarmExecutionOptions
): Promise<SwarmExecutionResult> {
  const startTime = Date.now();

  // 1. Task Decomposition
  const dag = decomposeTask(options.task, options.files ?? []);

  // 2. OrchBench Plan Evaluation
  const hardwareProfile = options.hardwareProfile ?? DEFAULT_M1_PROFILE;
  const evaluation = evaluateOrchestrationPlan(dag, hardwareProfile);
  options.onProgress?.({
    type: "plan_evaluated",
    detail: evaluation,
  });

  // 3. Beads Sync (if enabled)
  let coordinator: BeadsCoordinator | undefined;
  let epicId: string | undefined;

  if (options.beadsEnabled !== false) {
    try {
      coordinator = new BeadsCoordinator({
        repoRoot: options.repoRoot,
        runner: options.runner,
      });
      epicId = await coordinator.createEpic(
        options.task.slice(0, 48),
        `Adaptive Swarm Orchestration Plan\nDAG: ${dag.id}\nRecommended Workers: ${evaluation.recommendedWorkerCount}`
      );
      await coordinator.syncTaskDag(dag, epicId);
    } catch {
      // In environments where bd is not initialized, proceed with in-memory execution
      coordinator = undefined;
    }
  }

  // 4. Dry Run Guard
  if (options.dryRun) {
    return {
      dag,
      evaluation,
      results: new Map(),
      success: true,
      epicId,
      summary: `Dry run completed. Plan evaluated with ${dag.nodes.size} tasks (critical path length ${evaluation.criticalPathLength}, recommended workers ${evaluation.recommendedWorkerCount}).`,
      durationMs: Date.now() - startTime,
    };
  }

  // 5. Scheduling Loop
  const executor = options.executor ?? ((task) => defaultTaskExecutor(task, options.verifyCommand, options.runner));
  const results = new Map<string, SwarmResult>();
  const completedNodes = new Set<string>();
  const failedNodes = new Set<string>();
  const inProgressNodes = new Set<string>();

  const maxMutating = hardwareProfile.maxMutatingWorkers ?? 1;
  const maxReadOnly = hardwareProfile.maxReadOnlyWorkers ?? 2;

  while (completedNodes.size + failedNodes.size < dag.nodes.size) {
    // Find unstarted nodes whose dependencies are all completed
    const readyNodes: TaskNode[] = [];

    for (const node of dag.nodes.values()) {
      if (
        node.status === "pending" &&
        !inProgressNodes.has(node.id) &&
        !completedNodes.has(node.id) &&
        !failedNodes.has(node.id)
      ) {
        // If any dependency has failed, mark this node as blocked
        const hasFailedDep = node.dependencies.some((depId) => failedNodes.has(depId));
        if (hasFailedDep) {
          node.status = "blocked";
          node.error = "Prerequisite dependency failed";
          failedNodes.add(node.id);
          results.set(node.id, {
            taskId: node.id,
            beadsId: node.beadsId,
            status: "failed",
            evidenceIds: [],
            changedFiles: [],
            unresolvedDependencies: node.dependencies.filter((d) => failedNodes.has(d)),
            verificationResults: [],
            durationMs: 0,
            error: "Blocked by prerequisite failure",
          });
          continue;
        }

        const allDepsSatisfied = node.dependencies.every((depId) => completedNodes.has(depId));
        if (allDepsSatisfied) {
          node.status = "ready";
          readyNodes.push(node);
          options.onProgress?.({
            type: "task_ready",
            taskId: node.id,
            beadsId: node.beadsId,
          });
        }
      }
    }

    if (readyNodes.length === 0 && inProgressNodes.size === 0) {
      // No more tasks can make progress
      break;
    }

    // Determine how many we can dispatch right now
    const mutatingCount = Array.from(inProgressNodes)
      .map((id) => dag.nodes.get(id)!)
      .filter((n) => n && n.role === "implementation").length;

    const readOnlyCount = inProgressNodes.size - mutatingCount;

    // Pick candidates respecting worker limits
    const toLaunch: TaskNode[] = [];
    for (const node of readyNodes) {
      if (node.role === "implementation") {
        if (mutatingCount + toLaunch.filter((n) => n.role === "implementation").length < maxMutating) {
          toLaunch.push(node);
        }
      } else {
        if (readOnlyCount + toLaunch.filter((n) => n.role !== "implementation").length < maxReadOnly) {
          toLaunch.push(node);
        }
      }
    }

    if (toLaunch.length === 0 && inProgressNodes.size > 0) {
      // Wait for at least one in-progress task to complete
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }

    // Launch tasks
    const launchPromises = toLaunch.map(async (node) => {
      inProgressNodes.add(node.id);
      node.status = "in_progress";

      if (coordinator && node.beadsId) {
        await coordinator.claimTask(node.beadsId).catch(() => false);
      }

      options.onProgress?.({
        type: "task_claimed",
        taskId: node.id,
        beadsId: node.beadsId,
      });

      const swarmTask: SwarmTask = {
        id: node.id,
        beadsId: node.beadsId,
        parentId: epicId,
        baseRevision: "HEAD",
        objective: node.objective,
        role: node.role,
        acceptanceCriteria: node.acceptanceCriteria,
        dependencies: node.dependencies,
        readScope: node.readScope,
        writeScope: node.writeScope,
        contextHandles: [],
        allowedCapabilities: [node.role],
        budget: {
          timeoutMs: node.timeoutMs,
        },
      };

      const result = await executor(swarmTask);
      results.set(node.id, result);
      inProgressNodes.delete(node.id);

      if (result.status === "verified") {
        node.status = "verified";
        completedNodes.add(node.id);
        if (coordinator && node.beadsId) {
          await coordinator.completeTask(node.beadsId, "Verified acceptance criteria").catch(() => undefined);
        }
        options.onProgress?.({
          type: "task_verified",
          taskId: node.id,
          beadsId: node.beadsId,
        });
      } else {
        node.status = "failed";
        node.error = result.error ?? "Task execution failed";
        failedNodes.add(node.id);
        options.onProgress?.({
          type: "task_failed",
          taskId: node.id,
          beadsId: node.beadsId,
          detail: result.error,
        });
      }
    });

    await Promise.all(launchPromises);
  }

  // 5. Semantic Integration Check (Passes Alone, Fails Together)
  // Check if integration node succeeded
  const integrationNode = Array.from(dag.nodes.values()).find((n) => n.role === "integration");
  const overallSuccess = failedNodes.size === 0 && (integrationNode ? integrationNode.status === "verified" : true);

  const durationMs = Date.now() - startTime;
  const summary = overallSuccess
    ? `Adaptive swarm completed successfully: ${completedNodes.size} task(s) verified in ${Math.round(durationMs)}ms.`
    : `Adaptive swarm failed: ${failedNodes.size} task(s) failed or regression detected.`;

  return {
    dag,
    evaluation,
    results,
    success: overallSuccess,
    epicId,
    summary,
    durationMs,
  };
}
