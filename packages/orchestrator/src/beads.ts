import { runCommand, type CommandResult, type CommandSpec } from "@lattice/execution";
import type { TaskDAG, TaskNode } from "./types.js";

export type CommandRunner = (spec: CommandSpec) => Promise<CommandResult>;

export interface BeadsCoordinatorOptions {
  repoRoot: string;
  runner?: CommandRunner;
}

/**
 * Extracts a Beads issue ID (such as lat-123 or beads-abc) from stdout.
 */
export function parseBeadsIdFromOutput(output: string): string | undefined {
  if (!output) return undefined;
  // Look for issue identifier patterns e.g. "lat-xyz", "beads-123", "lat-merge-slot"
  const match = /(?:created issue:\s*|✓\s*|○\s*|^)([a-z0-9]+-[a-z0-9_-]+)/i.exec(output.trim());
  if (match && match[1]) {
    return match[1].trim();
  }
  // Try line-by-line fallback
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    const tokenMatch = /([a-z0-9]+-[a-z0-9_-]+)/i.exec(trimmed);
    if (tokenMatch && tokenMatch[1]) {
      return tokenMatch[1].trim();
    }
  }
  return undefined;
}

export class BeadsCoordinator {
  private readonly repoRoot: string;
  private readonly runner: CommandRunner;

  constructor(options: BeadsCoordinatorOptions) {
    this.repoRoot = options.repoRoot;
    this.runner = options.runner ?? runCommand;
  }

  private async executeBd(args: string[]): Promise<CommandResult> {
    const result = await this.runner({
      command: "bd",
      args,
      cwd: this.repoRoot,
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `bd ${args.join(" ")} failed with exit ${result.exitCode}: ${
          result.stderr || result.stdout
        }`
      );
    }
    return result;
  }

  /**
   * Creates a parent epic issue in Beads to anchor the swarm task graph.
   */
  async createEpic(title: string, description: string): Promise<string> {
    const args = [
      "create",
      `--title=[Lattice Swarm] ${title}`,
      `--description=${description}`,
      "--type=feature",
      "--priority=1",
    ];
    const res = await this.executeBd(args);
    const id = parseBeadsIdFromOutput(res.stdout);
    if (!id) {
      throw new Error(`Failed to parse epic ID from Beads output: ${res.stdout}`);
    }
    return id;
  }

  /**
   * Creates a subtask in Beads with acceptance criteria and optional parent.
   */
  async createTask(options: {
    parentId?: string;
    title: string;
    description: string;
    acceptance?: string;
    priority?: number;
  }): Promise<string> {
    const args = [
      "create",
      `--title=${options.title}`,
      `--description=${options.description}`,
      "--type=task",
      `--priority=${options.priority ?? 2}`,
    ];
    if (options.parentId) {
      args.push(`--parent=${options.parentId}`);
    }
    if (options.acceptance) {
      args.push(`--acceptance=${options.acceptance}`);
    }

    const res = await this.executeBd(args);
    const id = parseBeadsIdFromOutput(res.stdout);
    if (!id) {
      throw new Error(`Failed to parse task ID from Beads output: ${res.stdout}`);
    }
    return id;
  }

  /**
   * Adds an explicit dependency edge in Beads (issueId depends on dependsOnId).
   */
  async addDependency(issueId: string, dependsOnId: string): Promise<void> {
    await this.executeBd(["dep", "add", issueId, dependsOnId]);
  }

  /**
   * Atomically claims an issue in Beads.
   */
  async claimTask(issueId: string): Promise<boolean> {
    const res = await this.executeBd(["update", issueId, "--claim"]);
    return res.exitCode === 0;
  }

  /**
   * Queries Beads ready queue (all unblocked open issues).
   */
  async queryReadyTasks(): Promise<string[]> {
    const res = await this.executeBd(["ready"]);
    const readyIds: string[] = [];

    for (const line of res.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("---") || trimmed.startsWith("Ready:") || trimmed.startsWith("Status:")) {
        continue;
      }
      const match = /(?:○|◐)\s*([a-z0-9]+-[a-z0-9_-]+)/i.exec(trimmed);
      if (match && match[1]) {
        readyIds.push(match[1].trim());
      }
    }

    return readyIds;
  }

  /**
   * Closes a completed task with verified rationale.
   */
  async completeTask(issueId: string, reason?: string): Promise<void> {
    const args = ["close", issueId, "--suggest-next"];
    if (reason) {
      args.push(`--reason=${reason}`);
    }
    await this.executeBd(args);
  }

  /**
   * Registers a full TaskDAG into Beads:
   * 1. Creates Beads issues for each TaskNode (with acceptance criteria).
   * 2. Registers all dependency edges via bd dep add.
   * 3. Sets node.beadsId on each TaskNode in the DAG.
   */
  async syncTaskDag(dag: TaskDAG, epicId?: string): Promise<Map<string, string>> {
    const idMap = new Map<string, string>(); // node.id -> beadsId

    // 1. Create all task issues
    for (const node of dag.nodes.values()) {
      const acceptance = node.acceptanceCriteria.join("; ") || "Verified completion";
      const beadsId = await this.createTask({
        parentId: epicId,
        title: `[${node.role.toUpperCase()}] ${node.title}`,
        description: `${node.objective}\n\nWrite scope: ${node.writeScope.join(", ") || "none (read-only)"}\nRead scope: ${node.readScope.join(", ") || "all"}`,
        acceptance,
        priority: 2,
      });

      node.beadsId = beadsId;
      node.parentId = epicId;
      idMap.set(node.id, beadsId);
    }

    // 2. Link dependencies
    for (const edge of dag.edges) {
      const fromBeadsId = idMap.get(edge.from);
      const toBeadsId = idMap.get(edge.to);
      if (fromBeadsId && toBeadsId) {
        // toBeadsId depends on fromBeadsId
        await this.addDependency(toBeadsId, fromBeadsId);
      }
    }

    return idMap;
  }
}
