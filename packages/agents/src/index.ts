import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  digest,
  runCommand,
  type CommandResult,
  type CommandSpec,
} from "@lattice/execution";
import type {
  EvidenceRef,
  TapPacket,
  VerificationRecord,
  Verifier,
} from "@lattice/protocol";
import type {
  CandidateAction,
  ExperimentExecutor,
  ExperimentOutcome,
} from "@lattice/search";

export interface AgentTask {
  id?: string;
  prompt: string;
  context?: string[];
  timeoutMs?: number;
}

export interface AgentExecution {
  agent: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface AgentAdapter {
  readonly name: string;
  run(task: AgentTask, workspace: string): Promise<AgentExecution>;
}

export interface ProcessAgentConfig {
  name: string;
  command: string;
  args?: string[];
  promptMode?: "template" | "stdin";
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

function render(value: string, task: AgentTask, workspace: string): string {
  return value
    .replaceAll("{prompt}", task.prompt)
    .replaceAll("{workspace}", workspace)
    .replaceAll("{context}", (task.context ?? []).join("\n"));
}

export class ProcessAgentAdapter implements AgentAdapter {
  readonly name: string;

  constructor(private readonly config: ProcessAgentConfig) {
    this.name = config.name;
  }

  async run(task: AgentTask, workspace: string): Promise<AgentExecution> {
    const args = (this.config.args ?? []).map((arg) =>
      render(arg, task, workspace),
    );

    const stdin =
      this.config.promptMode === "stdin"
        ? [task.prompt, ...(task.context ?? [])].join("\n\n")
        : undefined;

    const result = await runCommand({
      command: this.config.command,
      args,
      cwd: workspace,
      stdin,
      env: this.config.env,
      timeoutMs: task.timeoutMs ?? this.config.timeoutMs ?? 10 * 60_000,
      maxOutputBytes: 1_000_000,
    });

    return {
      agent: this.name,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
    };
  }
}


export interface QwenCodePresetOptions {
  command?: string;
  model?: string;
  approvalMode?: "default" | "auto-edit" | "auto" | "yolo";
  outputFormat?: "json" | "stream-json" | "text";
  extraArgs?: string[];
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export function createQwenCodeAdapter(
  options: QwenCodePresetOptions = {},
): ProcessAgentAdapter {
  const args = [
    "--prompt",
    "{prompt}",
    "--output-format",
    options.outputFormat ?? "json",
  ];

  if (options.model) args.push("--model", options.model);
  if (options.approvalMode && options.approvalMode !== "default") {
    args.push("--approval-mode", options.approvalMode);
  }
  if (options.extraArgs?.length) args.push(...options.extraArgs);

  return new ProcessAgentAdapter({
    name: "qwen-code",
    command: options.command ?? "qwen",
    args,
    timeoutMs: options.timeoutMs,
    env: options.env,
  });
}

export interface OpenCodePresetOptions {
  command?: string;
  model?: string;
  agent?: string;
  autoApprove?: boolean;
  format?: "default" | "json";
  extraArgs?: string[];
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export function createOpenCodeAdapter(
  options: OpenCodePresetOptions = {},
): ProcessAgentAdapter {
  const args = ["run"];

  if (options.format) args.push("--format", options.format);
  if (options.model) args.push("--model", options.model);
  if (options.agent) args.push("--agent", options.agent);
  if (options.autoApprove) args.push("--auto");
  if (options.extraArgs?.length) args.push(...options.extraArgs);
  args.push("{prompt}");

  return new ProcessAgentAdapter({
    name: "opencode",
    command: options.command ?? "opencode",
    args,
    timeoutMs: options.timeoutMs,
    env: options.env,
  });
}

export interface WorktreeHandle {
  id: string;
  repoRoot: string;
  path: string;
  baseRevision: string;
}

async function gitOrThrow(
  cwd: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<CommandResult> {
  const result = await runCommand({
    command: "git",
    args,
    cwd,
    timeoutMs,
    maxOutputBytes: 2_000_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

export async function createDetachedWorktree(
  repoRootInput: string,
  baseRevision?: string,
): Promise<WorktreeHandle> {
  const repoRoot = resolve(repoRootInput);
  const top = await gitOrThrow(repoRoot, ["rev-parse", "--show-toplevel"]);
  const canonicalRoot = resolve(top.stdout.trim());

  const revision =
    baseRevision ??
    (await gitOrThrow(canonicalRoot, ["rev-parse", "HEAD"])).stdout.trim();

  const id = randomUUID();
  const path = await mkdtemp(join(tmpdir(), `lattice-${id.slice(0, 8)}-`));
  await gitOrThrow(canonicalRoot, [
    "worktree",
    "add",
    "--detach",
    path,
    revision,
  ]);

  return {
    id,
    repoRoot: canonicalRoot,
    path,
    baseRevision: revision,
  };
}

export async function removeWorktree(handle: WorktreeHandle): Promise<void> {
  try {
    await runCommand({
      command: "git",
      args: ["worktree", "remove", "--force", handle.path],
      cwd: handle.repoRoot,
      timeoutMs: 30_000,
    });
  } finally {
    await rm(handle.path, { recursive: true, force: true });
    await runCommand({
      command: "git",
      args: ["worktree", "prune"],
      cwd: handle.repoRoot,
      timeoutMs: 10_000,
    }).catch(() => undefined);
  }
}

export interface WorkspaceChanges {
  changedFiles: string[];
  untrackedFiles: string[];
  diff: string;
}

export async function captureWorkspaceChanges(
  workspace: string,
): Promise<WorkspaceChanges> {
  const status = await gitOrThrow(workspace, ["status", "--porcelain=v1"]);
  const diff = await gitOrThrow(workspace, [
    "diff",
    "--no-ext-diff",
    "--binary",
    "HEAD",
    "--",
  ]);

  const changedFiles: string[] = [];
  const untrackedFiles: string[] = [];

  for (const line of status.stdout.split("\n").filter(Boolean)) {
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (!file) continue;
    changedFiles.push(file);
    if (code === "??") untrackedFiles.push(file);
  }

  return {
    changedFiles,
    untrackedFiles,
    diff: diff.stdout,
  };
}

export type CleanupPolicy =
  | "always"
  | "never"
  | "on-success"
  | "on-failure";

export interface IsolatedAgentRunOptions {
  repoRoot: string;
  baseRevision?: string;
  task: AgentTask;
  adapter: AgentAdapter;
  verifyCommand?: CommandSpec;
  /** Structured verifier; when set it replaces `verifyCommand`. */
  verifier?: Verifier;
  cleanup?: CleanupPolicy;
}

export interface IsolatedAgentRunResult {
  workspace: WorktreeHandle;
  execution: AgentExecution;
  changes: WorkspaceChanges;
  verification?: CommandResult;
  verifierResult?: VerificationRecord;
  success: boolean;
  workspaceRetained: boolean;
}

export async function runIsolatedAgent(
  options: IsolatedAgentRunOptions,
): Promise<IsolatedAgentRunResult> {
  const workspace = await createDetachedWorktree(
    options.repoRoot,
    options.baseRevision,
  );

  let execution: AgentExecution | undefined;
  let verification: CommandResult | undefined;
  let verifierResult: VerificationRecord | undefined;
  let changes: WorkspaceChanges = {
    changedFiles: [],
    untrackedFiles: [],
    diff: "",
  };

  try {
    execution = await options.adapter.run(options.task, workspace.path);
    changes = await captureWorkspaceChanges(workspace.path);

    if (options.verifier) {
      verifierResult = await options.verifier.verify(workspace.path);
    } else if (options.verifyCommand) {
      verification = await runCommand({
        ...options.verifyCommand,
        cwd: workspace.path,
      });
    }

    const success =
      execution.exitCode === 0 &&
      !execution.timedOut &&
      (verifierResult === undefined || verifierResult.passed) &&
      (verification === undefined ||
        (verification.exitCode === 0 && !verification.timedOut));

    const cleanup = options.cleanup ?? "on-failure";
    const shouldCleanup =
      cleanup === "always" ||
      (cleanup === "on-success" && success) ||
      (cleanup === "on-failure" && !success);

    if (shouldCleanup) {
      await removeWorktree(workspace);
    }

    return {
      workspace,
      execution,
      changes,
      verification,
      verifierResult,
      success,
      workspaceRetained: !shouldCleanup,
    };
  } catch (error) {
    if ((options.cleanup ?? "on-failure") !== "never") {
      await removeWorktree(workspace).catch(() => undefined);
    }
    throw error;
  }
}



export interface ParallelAgentJob {
  id: string;
  task: AgentTask;
  adapter: AgentAdapter;
  verifyCommand?: CommandSpec;
  cleanup?: CleanupPolicy;
}

export type ParallelAgentJobResult =
  | {
      id: string;
      status: "fulfilled";
      result: IsolatedAgentRunResult;
    }
  | {
      id: string;
      status: "rejected";
      error: string;
    }
  | {
      id: string;
      status: "skipped";
      reason: string;
    };

export interface ParallelAgentRunOptions {
  repoRoot: string;
  baseRevision?: string;
  jobs: ParallelAgentJob[];
  maxConcurrency?: number;
  stopLaunchingAfterVerified?: boolean;
  onJobStart?: (job: ParallelAgentJob) => void | Promise<void>;
  onJobComplete?: (
    result: ParallelAgentJobResult,
  ) => void | Promise<void>;
}

async function pinnedRevision(
  repoRoot: string,
  requested?: string,
): Promise<string> {
  if (requested) return requested;
  return (
    await gitOrThrow(resolve(repoRoot), ["rev-parse", "HEAD"])
  ).stdout.trim();
}

export async function runParallelAgents(
  options: ParallelAgentRunOptions,
): Promise<ParallelAgentJobResult[]> {
  if (options.jobs.length === 0) return [];

  const maxConcurrency = Math.max(
    1,
    Math.min(options.maxConcurrency ?? 2, options.jobs.length),
  );
  const baseRevision = await pinnedRevision(
    options.repoRoot,
    options.baseRevision,
  );
  const results: Array<ParallelAgentJobResult | undefined> = new Array(
    options.jobs.length,
  );

  let cursor = 0;
  let verifiedFound = false;

  const worker = async (): Promise<void> => {
    while (true) {
      if (options.stopLaunchingAfterVerified && verifiedFound) return;

      const index = cursor++;
      if (index >= options.jobs.length) return;
      const job = options.jobs[index]!;

      if (options.stopLaunchingAfterVerified && verifiedFound) {
        results[index] = {
          id: job.id,
          status: "skipped",
          reason: "verified candidate already found",
        };
        continue;
      }

      await options.onJobStart?.(job);

      try {
        const result = await runIsolatedAgent({
          repoRoot: options.repoRoot,
          baseRevision,
          task: job.task,
          adapter: job.adapter,
          verifyCommand: job.verifyCommand,
          cleanup: job.cleanup,
        });

        const item: ParallelAgentJobResult = {
          id: job.id,
          status: "fulfilled",
          result,
        };
        results[index] = item;

        if (
          result.success &&
          result.verification?.exitCode === 0 &&
          !result.verification.timedOut
        ) {
          verifiedFound = true;
        }

        await options.onJobComplete?.(item);
      } catch (error) {
        const item: ParallelAgentJobResult = {
          id: job.id,
          status: "rejected",
          error: error instanceof Error ? error.message : String(error),
        };
        results[index] = item;
        await options.onJobComplete?.(item);
      }
    }
  };

  await Promise.all(
    Array.from({ length: maxConcurrency }, () => worker()),
  );

  for (let index = 0; index < options.jobs.length; index++) {
    if (!results[index]) {
      const job = options.jobs[index]!;
      results[index] = {
        id: job.id,
        status: "skipped",
        reason: verifiedFound
          ? "verified candidate already found"
          : "job was not scheduled",
      };
    }
  }

  return results as ParallelAgentJobResult[];
}

export function verifiedBatchResults(
  results: ParallelAgentJobResult[],
): Array<Extract<ParallelAgentJobResult, { status: "fulfilled" }>> {
  return results.filter(
    (
      item,
    ): item is Extract<ParallelAgentJobResult, { status: "fulfilled" }> =>
      item.status === "fulfilled" &&
      item.result.success &&
      item.result.verification?.exitCode === 0 &&
      !item.result.verification.timedOut,
  );
}

export interface PromotionOptions {
  branchName?: string;
  commitMessage?: string;
  authorName?: string;
  authorEmail?: string;
}

export interface PromotionResult {
  branch: string;
  commit: string;
  changedFiles: string[];
}

function safeBranchSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "");
  return normalized || "candidate";
}

export async function promoteVerifiedRun(
  result: IsolatedAgentRunResult,
  options: PromotionOptions = {},
): Promise<PromotionResult> {
  if (!result.success) {
    throw new Error("Cannot promote an unsuccessful agent run");
  }
  if (
    !result.verification ||
    result.verification.exitCode !== 0 ||
    result.verification.timedOut
  ) {
    throw new Error("Cannot promote a run without passing verification");
  }
  if (!result.workspaceRetained || !(await workspaceExists(result.workspace.path))) {
    throw new Error("Cannot promote a cleaned or missing worktree");
  }
  if (result.changes.changedFiles.length === 0) {
    throw new Error("Cannot promote a run with no changed files");
  }

  const branch =
    options.branchName ??
    `lattice/${safeBranchSegment(result.execution.agent)}-${result.workspace.id.slice(0, 8)}`;

  await gitOrThrow(result.workspace.path, ["switch", "-c", branch]);
  await gitOrThrow(result.workspace.path, ["add", "-A"]);

  const commitArgs = [
    "-c",
    `user.name=${options.authorName ?? "Lattice"}`,
    "-c",
    `user.email=${options.authorEmail ?? "lattice@localhost"}`,
    "commit",
    "-m",
    options.commitMessage ?? `Lattice verified candidate from ${result.execution.agent}`,
  ];
  await gitOrThrow(result.workspace.path, commitArgs);

  const commit = (
    await gitOrThrow(result.workspace.path, ["rev-parse", "HEAD"])
  ).stdout.trim();

  return {
    branch,
    commit,
    changedFiles: [...result.changes.changedFiles],
  };
}

function evidence(
  kind: EvidenceRef["kind"],
  source: string,
  summary: string,
  verified: boolean,
): EvidenceRef {
  return {
    id: `ev:${digest(`${kind}\0${source}\0${summary}`).slice(0, 20)}`,
    kind,
    source,
    summary,
    verified,
    createdAt: new Date().toISOString(),
  };
}

export interface AgentExperimentOptions {
  adapter: AgentAdapter;
  verifyCommand?: CommandSpec;
  verifier?: Verifier;
  cleanup?: CleanupPolicy;
}

export function createAgentExperimentExecutor(
  options: AgentExperimentOptions,
): ExperimentExecutor {
  return {
    async execute(
      candidate: CandidateAction,
      tap: TapPacket,
    ): Promise<ExperimentOutcome> {
      if (!tap.repo?.root) {
        throw new Error("Agent experiment requires TAP repository root");
      }

      const prompt = [
        `Repository task: ${tap.task}`,
        `Selected action: ${candidate.label}`,
        candidate.action,
        `Expected evidence: ${candidate.expectedEvidence}`,
        "Make only changes relevant to this selected action.",
      ].join("\n");

      const result = await runIsolatedAgent({
        repoRoot: tap.repo.root,
        baseRevision: tap.repo.revision,
        task: {
          id: candidate.id,
          prompt,
          context: tap.context.slice(-12),
        },
        adapter: options.adapter,
        verifyCommand: options.verifyCommand,
        verifier: options.verifier,
        cleanup: options.cleanup,
      });

      const records: EvidenceRef[] = [
        evidence(
          "model",
          result.execution.agent,
          [
            `exit=${result.execution.exitCode}`,
            `changed=${result.changes.changedFiles.join(",") || "none"}`,
            `workspace_retained=${result.workspaceRetained}`,
          ].join(" "),
          false,
        ),
      ];

      if (result.verification) {
        records.push(
          evidence(
            "command",
            [
              result.verification.command,
              ...result.verification.args,
            ].join(" "),
            [
              `exit=${result.verification.exitCode}`,
              `timeout=${result.verification.timedOut}`,
              result.verification.stdout.trim()
                ? `stdout=${result.verification.stdout.trim().slice(0, 400)}`
                : undefined,
              result.verification.stderr.trim()
                ? `stderr=${result.verification.stderr.trim().slice(0, 400)}`
                : undefined,
            ]
              .filter(Boolean)
              .join(" "),
            result.verification.exitCode === 0 &&
              !result.verification.timedOut,
          ),
        );
      }

      if (result.verifierResult) records.push(...result.verifierResult.evidence);

      const verifiedSuccess = result.verifierResult
        ? result.verifierResult.passed
        : result.verification !== undefined &&
          result.verification.exitCode === 0 &&
          !result.verification.timedOut;

      return {
        candidateId: candidate.id,
        status: verifiedSuccess
          ? "success"
          : result.execution.exitCode === 0
            ? "inconclusive"
            : "failure",
        terminal: verifiedSuccess,
        summary: [
          `agent=${result.execution.agent}`,
          `agent_exit=${result.execution.exitCode}`,
          `changed=${result.changes.changedFiles.length}`,
          result.verifierResult
            ? `verify=${result.verifierResult.summary}`
            : result.verification
              ? `verify_exit=${result.verification.exitCode}`
              : "verify=not_run",
          `worktree=${result.workspace.path}`,
        ].join(" "),
        evidence: records,
        uncertainties: verifiedSuccess
          ? undefined
          : ["agent result is not yet backed by a passing verification command"],
      };
    },
  };
}

export async function workspaceExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
