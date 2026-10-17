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

import {
  captureWorkspaceChanges,
  diffChangeSets,
  emptyWorkspaceChanges,
  evaluateChangeSet,
  gitHonorsFileMode,
  parseRawDiff,
  resolveChangePolicy,
  snapshotWorktreeMetadata,
  worktreeMetadataChanges,
  type ChangePolicyViolation,
  type ChangeSetDrift,
  type ChangeSetPolicy,
  type ChangeSetPolicyResolved,
  type WorkspaceChangeSet,
  type WorkspaceChanges,
} from "./changeset.js";

export {
  DEFAULT_CHANGE_POLICY,
  WorkspaceCaptureError,
  captureWorkspaceChanges,
  diffChangeSets,
  emptyChangeSet,
  emptyWorkspaceChanges,
  evaluateChangeSet,
  gitHonorsFileMode,
  parseRawDiff,
  resolveChangePolicy,
  snapshotWorktreeMetadata,
  worktreeMetadataChanges,
  type CaptureWorkspaceOptions,
  type ChangePolicyViolation,
  type ChangePolicyViolationCode,
  type ChangeSetDrift,
  type ChangeSetEntry,
  type ChangeSetPolicy,
  type ChangeSetPolicyResolved,
  type WorkspaceChangeSet,
  type WorkspaceChanges,
  type WorktreeMetadataSnapshot,
} from "./changeset.js";

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
  /** Environment the worker ran with: policy and variable names, never values. */
  environment?: { policy: "minimal" | "inherit"; names: string[] };
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
  /** Explicit values set for the worker; always passed. */
  env?: Record<string, string | undefined>;
  /**
   * Parent variable names the worker may read, e.g. its provider API key.
   * Everything else in the Lattice process environment is withheld.
   */
  allowEnv?: string[];
  /**
   * Opt in to passing the full parent environment. For local debugging only:
   * the worker can then read every secret Lattice can.
   */
  trustedHost?: boolean;
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

    const envPolicy = this.config.trustedHost ? "inherit" : "minimal";
    const result = await runCommand({
      command: this.config.command,
      args,
      cwd: workspace,
      stdin,
      env: this.config.env,
      envPolicy,
      allowEnv: this.config.allowEnv,
      killTree: true,
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
      environment: { policy: envPolicy, names: result.envNames ?? [] },
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
  /** Replaces {@link QWEN_CODE_ENV}; the names the worker may read. */
  allowEnv?: string[];
  trustedHost?: boolean;
  timeoutMs?: number;
}

/**
 * Login state lives under HOME/XDG dirs for both CLIs, so they are declared
 * here rather than added to every worker's base environment.
 */
const CLI_HOME_ENV = ["HOME", "USER", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];

/** Variables Qwen Code reads for its model endpoint and login state. */
export const QWEN_CODE_ENV: readonly string[] = [
  ...CLI_HOME_ENV,
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "DASHSCOPE_API_KEY",
];

/** Variables OpenCode reads for common providers and its own config. */
export const OPENCODE_ENV: readonly string[] = [
  ...CLI_HOME_ENV,
  "OPENCODE_CONFIG",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
];

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
    allowEnv: options.allowEnv ?? [...QWEN_CODE_ENV],
    trustedHost: options.trustedHost,
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
  /** Replaces {@link OPENCODE_ENV}; the names the worker may read. */
  allowEnv?: string[];
  trustedHost?: boolean;
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
    allowEnv: options.allowEnv ?? [...OPENCODE_ENV],
    trustedHost: options.trustedHost,
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
  /**
   * What a candidate may introduce. Symlinks, submodules and unmerged paths
   * are denied by default; oversized candidates are captured but not promoted.
   */
  changesPolicy?: ChangeSetPolicy;
}

/**
 * The link between a verification result and the exact candidate it checked.
 * `trusted` is false when verification itself changed the worktree, when the
 * workspace could not be recaptured, or when Git wiring moved during the run.
 */
export interface VerificationIntegrity {
  changeSetDigest: string;
  recapturedChangeSetDigest?: string;
  trusted: boolean;
  drift?: ChangeSetDrift;
  error?: string;
}

export interface IsolatedAgentRunResult {
  workspace: WorktreeHandle;
  execution: AgentExecution;
  changes: WorkspaceChanges;
  /** Complete, content-addressed candidate that verification checked. */
  changeSet: WorkspaceChangeSet;
  /** Resolved policy the candidate was captured and checked under. */
  changePolicy: ChangeSetPolicyResolved;
  verification?: CommandResult;
  verifierResult?: VerificationRecord;
  verificationIntegrity?: VerificationIntegrity;
  /** Why verification was not run, e.g. the candidate could not be captured. */
  verificationSkipped?: string;
  /** Capture failure; the run is unsuccessful and no change set is trusted. */
  captureError?: string;
  success: boolean;
  workspaceRetained: boolean;
  /**
   * Branches or tags of the main repository that moved or vanished while the
   * worker or its verification ran. Worktrees share refs with the main
   * checkout, so this is how a worker escaping its worktree through git shows
   * up. Any entry fails the run. Absent when nothing changed.
   */
  refTamper?: string[];
  /** Symlink/submodule/oversize/path-containment policy failures. */
  policyViolations?: ChangePolicyViolation[];
  /** The worker committed, moving its own HEAD away from the pinned base. */
  headMoved?: { baseRevision: string; head: string };
  /** The worktree's `.git` file, Git dir or top level changed during the run. */
  gitMetadataTamper?: string[];
}

/** Branch and tag tips of a repository, keyed by ref name. */
export async function snapshotSharedRefs(repoRoot: string): Promise<Map<string, string>> {
  const result = await gitOrThrow(repoRoot, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/heads",
    "refs/tags",
  ]);
  const refs = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    const space = line.lastIndexOf(" ");
    if (space > 0) refs.set(line.slice(0, space), line.slice(space + 1));
  }
  return refs;
}

/**
 * Pre-existing refs that moved or were deleted. New refs are not reported:
 * they cannot overwrite anything, and promotion creates its own branch.
 */
export function changedSharedRefs(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  const changed: string[] = [];
  for (const [ref, oid] of before) {
    const now = after.get(ref);
    if (now === undefined) changed.push(`${ref}: deleted`);
    else if (now !== oid) changed.push(`${ref}: ${oid.slice(0, 12)}->${now.slice(0, 12)}`);
  }
  return changed.sort();
}

export interface ObjectiveVerificationStatus {
  ran: boolean;
  passed: boolean;
  objective: boolean;
  tool?: string;
  evidenceIds: string[];
  reason?: string;
}

/**
 * Reasons a verification tool's own verdict cannot be trusted for this
 * candidate. A passing test over a workspace that changed after capture, or
 * over a candidate that broke the change policy, is not evidence of success.
 */
export function verificationBlockers(result: IsolatedAgentRunResult): string[] {
  const blockers: string[] = [];
  if (result.refTamper?.length) {
    blockers.push(`shared refs changed (${result.refTamper.join(", ")})`);
  }
  if (result.headMoved) {
    blockers.push(
      `worker moved HEAD from ${result.headMoved.baseRevision.slice(0, 12)} to ${result.headMoved.head.slice(0, 12)}`,
    );
  }
  if (result.gitMetadataTamper?.length) {
    blockers.push(`Git metadata changed (${result.gitMetadataTamper.join(", ")})`);
  }
  for (const violation of result.policyViolations ?? []) {
    blockers.push(`change policy: ${violation.message}`);
  }
  if (result.captureError) {
    blockers.push(`candidate capture failed (${result.captureError})`);
  }
  if (result.verificationIntegrity && !result.verificationIntegrity.trusted) {
    const drift = result.verificationIntegrity.drift;
    const paths = drift
      ? [...drift.added, ...drift.removed, ...drift.modified].slice(0, 8)
      : [];
    blockers.push(
      result.verificationIntegrity.error
        ? `workspace could not be recaptured (${result.verificationIntegrity.error})`
        : `verification changed the workspace${paths.length ? ` (${paths.join(", ")})` : ""}`,
    );
  }
  return blockers;
}

export function objectiveVerification(
  result: IsolatedAgentRunResult,
): ObjectiveVerificationStatus {
  const blockers = verificationBlockers(result);
  const blocked = blockers.length > 0 ? blockers.join("; ") : undefined;

  if (result.verifierResult) {
    return {
      ran: true,
      passed: result.verifierResult.passed && blockers.length === 0,
      objective: true,
      tool: result.verifierResult.tool,
      evidenceIds: result.verifierResult.evidence
        ? result.verifierResult.evidence.map((e) => e.id)
        : [],
      reason: blocked ?? result.verifierResult.summary,
    };
  }

  if (result.verification) {
    return {
      ran: true,
      passed:
        result.verification.exitCode === 0 &&
        !result.verification.timedOut &&
        blockers.length === 0,
      objective: true,
      tool: "command",
      evidenceIds: [],
      ...(blocked ? { reason: blocked } : {}),
    };
  }

  return {
    ran: false,
    passed: false,
    objective: false,
    evidenceIds: [],
    reason: blocked ?? (result.verificationSkipped ?? "no verifier configured"),
  };
}

export async function runIsolatedAgent(
  options: IsolatedAgentRunOptions,
): Promise<IsolatedAgentRunResult> {
  if (options.verifyCommand && options.verifier) {
    throw new Error("Cannot specify both verifyCommand and verifier");
  }

  const workspace = await createDetachedWorktree(
    options.repoRoot,
    options.baseRevision,
  );

  let refsBefore: Map<string, string>;
  let metadataBefore;
  try {
    refsBefore = await snapshotSharedRefs(workspace.repoRoot);
    // The resolved HEAD, not a branch name the parent might move, is the
    // revision every capture is compared with.
    metadataBefore = await snapshotWorktreeMetadata(workspace.path);
  } catch (error) {
    await removeWorktree(workspace).catch(() => undefined);
    throw error;
  }

  const policy = resolveChangePolicy(options.changesPolicy);
  const baseRevision = metadataBefore.head;

  let execution: AgentExecution | undefined;
  let verification: CommandResult | undefined;
  let verifierResult: VerificationRecord | undefined;
  let verificationIntegrity: VerificationIntegrity | undefined;
  let verificationSkipped: string | undefined;
  let captureError: string | undefined;
  let changes = emptyWorkspaceChanges(baseRevision);
  let policyViolations: ChangePolicyViolation[] = [];
  let headMoved: IsolatedAgentRunResult["headMoved"];
  const gitMetadataTamper: string[] = [];

  try {
    execution = await options.adapter.run(options.task, workspace.path);

    // Capture only trusts a worktree whose Git wiring still points at this
    // worktree; otherwise `git diff` could be reading somebody else's repo.
    let metadataAfter;
    try {
      metadataAfter = await snapshotWorktreeMetadata(workspace.path);
      gitMetadataTamper.push(
        ...worktreeMetadataChanges(metadataBefore, metadataAfter),
      );
    } catch (error) {
      gitMetadataTamper.push(
        `Git metadata unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (metadataAfter && metadataAfter.head !== baseRevision) {
      headMoved = { baseRevision, head: metadataAfter.head };
    }

    if (gitMetadataTamper.length === 0) {
      try {
        changes = await captureWorkspaceChanges(workspace.path, {
          baseRevision,
          policy,
        });
        policyViolations = await evaluateChangeSet(
          changes.changeSet,
          workspace.path,
          policy,
        );
      } catch (error) {
        captureError = error instanceof Error ? error.message : String(error);
        changes = emptyWorkspaceChanges(baseRevision);
      }
    } else {
      captureError =
        "Git wiring changed during the run; the candidate was not captured";
    }

    if (captureError) {
      // Do not run a trusted verifier over a state we could not identify.
      verificationSkipped = captureError;
    } else {
      if (options.verifier) {
        verifierResult = await options.verifier.verify(workspace.path);
      } else if (options.verifyCommand) {
        verification = await runCommand({
          killTree: true,
          ...options.verifyCommand,
          cwd: workspace.path,
        });
      }

      // Verification is only evidence for the candidate captured before it.
      // Re-read the worktree immediately afterwards and refuse to trust a
      // verdict when bytes, modes, or Git wiring moved in between.
      try {
        const metadataPost = await snapshotWorktreeMetadata(workspace.path);
        for (const change of worktreeMetadataChanges(metadataBefore, metadataPost)) {
          gitMetadataTamper.push(`after verification: ${change}`);
        }
        if (metadataPost.head !== baseRevision && !headMoved) {
          headMoved = { baseRevision, head: metadataPost.head };
        }
      } catch (error) {
        gitMetadataTamper.push(
          `Git metadata unreadable after verification: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      try {
        const after = await captureWorkspaceChanges(workspace.path, {
          baseRevision,
          policy,
        });
        const drift = diffChangeSets(changes.changeSet, after.changeSet);
        verificationIntegrity = {
          changeSetDigest: changes.changeSet.changeSetDigest,
          recapturedChangeSetDigest: after.changeSet.changeSetDigest,
          trusted: !drift.changed && gitMetadataTamper.length === 0,
          ...(drift.changed ? { drift } : {}),
        };
      } catch (error) {
        verificationIntegrity = {
          changeSetDigest: changes.changeSet.changeSetDigest,
          trusted: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const refTamper = changedSharedRefs(
      refsBefore,
      await snapshotSharedRefs(workspace.repoRoot),
    );

    const commandPassed =
      verification === undefined ||
      (verification.exitCode === 0 && !verification.timedOut);
    const toolPassed =
      verifierResult === undefined || verifierResult.passed;

    const success =
      refTamper.length === 0 &&
      execution.exitCode === 0 &&
      !execution.timedOut &&
      commandPassed &&
      toolPassed &&
      !captureError &&
      policyViolations.length === 0 &&
      !headMoved &&
      gitMetadataTamper.length === 0 &&
      verificationIntegrity?.trusted !== false;

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
      changeSet: changes.changeSet,
      changePolicy: policy,
      verification,
      verifierResult,
      ...(verificationIntegrity ? { verificationIntegrity } : {}),
      ...(verificationSkipped ? { verificationSkipped } : {}),
      ...(captureError ? { captureError } : {}),
      success,
      workspaceRetained: !shouldCleanup,
      ...(refTamper.length ? { refTamper } : {}),
      ...(policyViolations.length ? { policyViolations } : {}),
      ...(headMoved ? { headMoved } : {}),
      ...(gitMetadataTamper.length ? { gitMetadataTamper } : {}),
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
  verifier?: Verifier;
  cleanup?: CleanupPolicy;
  /** Overrides {@link ParallelAgentRunOptions.changesPolicy} for this job. */
  changesPolicy?: ChangeSetPolicy;
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
  /** Change policy shared by every job that does not override it. */
  changesPolicy?: ChangeSetPolicy;
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
          verifier: job.verifier,
          cleanup: job.cleanup,
          changesPolicy: job.changesPolicy ?? options.changesPolicy,
        });

        const item: ParallelAgentJobResult = {
          id: job.id,
          status: "fulfilled",
          result,
        };
        results[index] = item;

        if (result.success && objectiveVerification(result).passed) {
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
      objectiveVerification(item.result).passed,
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
  /** Identity of the verified candidate that was committed. */
  changeSetDigest: string;
}

function safeBranchSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "");
  return normalized || "candidate";
}

const STATUS_CODE: Record<WorkspaceChangeSet["entries"][number]["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  unmerged: "U",
};

interface StagedExpectation {
  status: string;
  modeBefore?: string;
  modeAfter?: string;
}

/**
 * The index uses no rename detection, so a captured rename becomes a delete
 * plus an add. Building the expected shape up front avoids trusting a blind
 * `git add -A` after verification.
 */
function expectedStagedManifest(
  changeSet: WorkspaceChangeSet,
): Map<string, StagedExpectation> {
  const expected = new Map<string, StagedExpectation>();
  for (const entry of changeSet.entries) {
    if (entry.status === "unmerged") {
      throw new Error(`Cannot promote unmerged path ${entry.path}`);
    }
    if ((entry.status === "renamed" || entry.status === "copied") && entry.oldPath) {
      if (entry.status === "renamed") {
        expected.set(entry.oldPath, {
          status: "D",
          ...(entry.modeBefore ? { modeBefore: entry.modeBefore } : {}),
        });
      }
      expected.set(entry.path, {
        status: "A",
        ...(entry.modeAfter ? { modeAfter: entry.modeAfter } : {}),
      });
      continue;
    }
    expected.set(entry.path, {
      status: STATUS_CODE[entry.status],
      ...(entry.modeBefore ? { modeBefore: entry.modeBefore } : {}),
      ...(entry.modeAfter ? { modeAfter: entry.modeAfter } : {}),
    });
  }
  return expected;
}

function compareStagedManifest(
  expected: Map<string, StagedExpectation>,
  actual: ReturnType<typeof parseRawDiff>,
  honorFileMode: boolean,
): string[] {
  const problems: string[] = [];
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));

  for (const [path, want] of expected) {
    const got = actualByPath.get(path);
    if (!got) {
      problems.push(`${path}: not staged`);
      continue;
    }
    const gotStatus = STATUS_CODE[got.status];
    if (gotStatus !== want.status) {
      problems.push(`${path}: expected ${want.status}, staged ${gotStatus}`);
    }
    const checkMode = (mode: string | undefined): boolean =>
      mode !== undefined && (honorFileMode || !/^100(644|755)$/.test(mode));
    if (checkMode(want.modeBefore) && got.oldMode !== want.modeBefore) {
      problems.push(`${path}: expected mode ${want.modeBefore}, staged ${got.oldMode}`);
    }
    if (checkMode(want.modeAfter) && got.newMode !== want.modeAfter) {
      problems.push(`${path}: expected mode ${want.modeAfter}, staged ${got.newMode}`);
    }
  }
  for (const entry of actual) {
    if (!expected.has(entry.path)) {
      problems.push(`${entry.path}: staged but not part of the verified candidate`);
    }
  }
  return problems;
}

function describeDrift(drift: ChangeSetDrift): string {
  const parts: string[] = [];
  if (drift.added.length) parts.push(`added: ${drift.added.slice(0, 8).join(", ")}`);
  if (drift.removed.length) parts.push(`removed: ${drift.removed.slice(0, 8).join(", ")}`);
  if (drift.modified.length) parts.push(`modified: ${drift.modified.slice(0, 8).join(", ")}`);
  if (drift.entryCountBefore !== undefined) {
    parts.push(`entries: ${drift.entryCountBefore}->${drift.entryCountAfter}`);
  }
  return parts.join("; ") || "content or modes changed";
}

export async function promoteVerifiedRun(
  result: IsolatedAgentRunResult,
  options: PromotionOptions = {},
): Promise<PromotionResult> {
  if (!result.success) {
    throw new Error("Cannot promote an unsuccessful agent run");
  }
  const objective = objectiveVerification(result);
  if (!objective.ran || !objective.passed) {
    throw new Error(
      `Cannot promote a run without passing verification${objective.reason ? `: ${objective.reason}` : ""}`,
    );
  }
  if (!result.workspaceRetained || !(await workspaceExists(result.workspace.path))) {
    throw new Error("Cannot promote a cleaned or missing worktree");
  }
  if (!result.changeSet || result.changeSet.entries.length === 0) {
    throw new Error("Cannot promote a run with no captured change set");
  }

  const workspace = result.workspace.path;
  const baseRevision = result.changeSet.baseRevision;
  const policy = result.changePolicy ?? {};

  // The candidate must still be the one verification saw. This is the TOCTOU
  // guard that a background process or a late verifier write would trip.
  const current = await captureWorkspaceChanges(workspace, {
    baseRevision,
    policy,
  });
  if (current.changeSet.changeSetDigest !== result.changeSet.changeSetDigest) {
    throw new Error(
      `Cannot promote: workspace changed after verification (${describeDrift(
        diffChangeSets(result.changeSet, current.changeSet),
      )})`,
    );
  }

  const expected = expectedStagedManifest(result.changeSet);

  // Start from the pinned revision, not from whatever a worker may have
  // staged, then stage exactly the paths in the verified manifest.
  const resetIndex = async (): Promise<void> => {
    await gitOrThrow(workspace, ["read-tree", "--reset", baseRevision]).catch(
      () => undefined,
    );
  };
  await gitOrThrow(workspace, ["read-tree", "--reset", baseRevision]);

  const pathspecs = [...new Set(expected.keys())].sort();
  const staged = await runCommand({
    command: "git",
    args: ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
    cwd: workspace,
    stdin: `${pathspecs.join("\0")}\0`,
    timeoutMs: 60_000,
  });
  if (staged.exitCode !== 0) {
    await resetIndex();
    throw new Error(
      `Cannot promote: staging the verified paths failed: ${staged.stderr.trim() || staged.stdout.trim()}`,
    );
  }

  // Staging reads the worktree. If anything moved while it did, the index is
  // no longer a copy of the verified candidate.
  const afterStaging = await captureWorkspaceChanges(workspace, {
    baseRevision,
    policy,
  }).catch((error: unknown) => {
    throw new Error(
      `Cannot promote: workspace could not be recaptured after staging (${error instanceof Error ? error.message : String(error)})`,
    );
  });
  if (afterStaging.changeSet.changeSetDigest !== result.changeSet.changeSetDigest) {
    await resetIndex();
    throw new Error(
      `Cannot promote: workspace changed while the candidate was being staged (${describeDrift(
        diffChangeSets(result.changeSet, afterStaging.changeSet),
      )})`,
    );
  }

  const stagedManifest = await gitOrThrow(workspace, [
    "diff",
    "--cached",
    "--raw",
    "--no-renames",
    "-z",
    "--no-abbrev",
    baseRevision,
    "--",
  ]);
  const manifestProblems = compareStagedManifest(
    expected,
    parseRawDiff(stagedManifest.stdout),
    await gitHonorsFileMode(workspace),
  );
  if (manifestProblems.length) {
    await resetIndex();
    throw new Error(
      `Cannot promote: staged change set does not match the verified candidate (${manifestProblems.slice(0, 8).join("; ")})`,
    );
  }

  const branch =
    options.branchName ??
    `lattice/${safeBranchSegment(result.execution.agent)}-${result.workspace.id.slice(0, 8)}`;

  await gitOrThrow(workspace, ["switch", "-c", branch]);

  // Hooks are repository content, not Lattice policy: a pre-commit hook could
  // add files after the manifest check. Point hooks at an empty directory.
  const hooksPath = join(tmpdir(), "lattice-no-hooks");
  const commitArgs = [
    "-c",
    "core.hooksPath=" + hooksPath,
    "-c",
    `user.name=${options.authorName ?? "Lattice"}`,
    "-c",
    `user.email=${options.authorEmail ?? "lattice@localhost"}`,
    "commit",
    "--no-verify",
    "-m",
    options.commitMessage ?? `Lattice verified candidate from ${result.execution.agent}`,
  ];
  await gitOrThrow(workspace, commitArgs);

  // A hook or filter must not have widened the commit after the index check.
  const committed = await gitOrThrow(workspace, [
    "diff-tree",
    "--no-commit-id",
    "--raw",
    "--no-renames",
    "-r",
    "-z",
    "--no-abbrev",
    baseRevision,
    "HEAD",
  ]);
  const commitProblems = compareStagedManifest(
    expected,
    parseRawDiff(committed.stdout),
    await gitHonorsFileMode(workspace),
  );
  if (commitProblems.length) {
    throw new Error(
      `Promoted commit does not match the verified candidate (${commitProblems.slice(0, 8).join("; ")})`,
    );
  }

  const commit = (
    await gitOrThrow(workspace, ["rev-parse", "HEAD"])
  ).stdout.trim();

  return {
    branch,
    commit,
    changedFiles: [...result.changes.changedFiles],
    changeSetDigest: result.changeSet.changeSetDigest,
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
  changesPolicy?: ChangeSetPolicy;
}

function envSummary(environment: AgentExecution["environment"]): string | undefined {
  if (!environment) return undefined;
  // Under inherit the name list is the whole host environment; the policy is
  // the fact worth recording.
  return environment.policy === "inherit"
    ? "env=inherit"
    : `env=minimal:${environment.names.join(",") || "none"}`;
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
        changesPolicy: options.changesPolicy,
      });

      const verificationPassed = result.verifierResult
        ? result.verifierResult.passed
        : result.verification !== undefined &&
          result.verification.exitCode === 0 &&
          !result.verification.timedOut;
      const verifiedSuccess =
        result.success &&
        verificationPassed &&
        result.changes.changedFiles.length > 0;
      const blockers = verificationBlockers(result);

      const records: EvidenceRef[] = [
        evidence(
          "model",
          result.execution.agent,
          [
            `exit=${result.execution.exitCode}`,
            `changed=${result.changes.changedFiles.join(",") || "none"}`,
            `workspace_retained=${result.workspaceRetained}`,
            envSummary(result.execution.environment),
            result.refTamper ? `ref_tamper=${result.refTamper.join(";")}` : undefined,
            result.headMoved ? "head_moved" : undefined,
            result.gitMetadataTamper ? "git_metadata_tamper" : undefined,
          ]
            .filter(Boolean)
            .join(" "),
          false,
        ),
        evidence(
          "repository",
          "lattice.changeset",
          [
            `digest=${result.changeSet.changeSetDigest.slice(0, 20)}`,
            `entries=${result.changeSet.entryCount}`,
            `patch_truncated=${result.changeSet.patchTruncated}`,
            `verified=${verifiedSuccess}`,
            result.verificationIntegrity
              ? `verification_trusted=${result.verificationIntegrity.trusted}`
              : undefined,
            result.policyViolations?.length
              ? `policy=${result.policyViolations.map((violation) => violation.code).join(",")}`
              : undefined,
            result.captureError ? "capture_failed" : undefined,
          ]
            .filter(Boolean)
            .join(" "),
          verifiedSuccess,
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

      return {
        candidateId: candidate.id,
        status: verifiedSuccess
          ? "success"
          : result.execution.exitCode === 0 &&
              !result.refTamper &&
              !result.captureError &&
              !result.headMoved &&
              !result.gitMetadataTamper?.length
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
          `changeset=${result.changeSet.changeSetDigest.slice(0, 16)}`,
          `worktree=${result.workspace.path}`,
          result.refTamper ? `ref_tamper=${result.refTamper.length}` : undefined,
          result.policyViolations?.length
            ? `policy_violations=${result.policyViolations.map((violation) => violation.code).join(",")}`
            : undefined,
          result.verificationIntegrity && !result.verificationIntegrity.trusted
            ? "verification_untrusted"
            : undefined,
        ]
          .filter(Boolean)
          .join(" "),
        evidence: records,
        changes: {
          diff: result.changes.diff,
          changedFiles: result.changes.changedFiles,
          untrackedFiles: result.changes.untrackedFiles,
          workspace: result.workspace.path,
          retained: result.workspaceRetained,
          changeSetDigest: result.changeSet.changeSetDigest,
          ...(result.policyViolations?.length
            ? { policyViolations: result.policyViolations.map((violation) => violation.code) }
            : {}),
          ...(result.verificationIntegrity
            ? { verificationTrusted: result.verificationIntegrity.trusted }
            : {}),
        },
        uncertainties: verifiedSuccess
          ? undefined
          : blockers.length
            ? blockers
            : ["Implementation requires actual changes, a successful agent and passing verification"],
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
