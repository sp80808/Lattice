import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { PLAN_SYSTEM, readPlanSources } from "./planning.js";
import {
  collectRepositorySnapshot,
  digest,
  runCommand,
  type CommandResult,
  type CommandSpec,
} from "@lattice/execution";
import {
  runSearchLoop,
  type AutonomyPolicy,
  type DecisionReviewer,
  type ExperimentExecutor,
  type ProposalPrompt,
  type SearchBudgetLimits,
} from "@lattice/search";
import {
  TAP_VERSION,
  type EvidenceRef,
  type RunEvent,
  type RunResult,
  type DecisionProvider,
  type GeneratorProvider,
  type PermissionOutcome,
  type RunLease,
  type RunLiveness,
  type TapPacket,
  type TaskIntent,
  type ToolCapability,
  type Verifier,
} from "@lattice/protocol";

export interface RunTaskOptions {
  cwd?: string;
  latticeDir?: string;
  /** Lease lifetime without a heartbeat before readers treat the run as interrupted. */
  leaseTtlMs?: number;
  /** Called after each event is durably appended. Listener errors are ignored. */
  onEvent?: (event: RunEvent) => void;
  verifyCommand?: CommandSpec;
  /** The user's task intent; recorded on `run.started` for replay. */
  intent?: TaskIntent;
  /** Effective per-capability grants; recorded on `run.started` for replay. */
  permissions?: Record<ToolCapability, PermissionOutcome>;
  /** Where this run came from, recorded on `run.started` (e.g. the run it replays). */
  lineage?: { replayOf?: string };
  /** Runs `verifyCommand`; defaults to `runCommand`. Replay swaps in recorded results. */
  commandRunner?: (spec: CommandSpec) => Promise<CommandResult>;
  /** Structured verifier (e.g. `tsr witness`); its record is stored in the run log. */
  verifier?: Verifier;
  /** Aborting stops the search between rounds; the run is logged as failed. */
  signal?: AbortSignal;
  /** Generates a draft only; incompatible with command verification and code search. */
  plan?: { generator: GeneratorProvider; files: string[] };
  search?: {
    generator: GeneratorProvider;
    decision: DecisionProvider;
    executor: ExperimentExecutor;
    maxRounds?: number;
    candidatesPerRound?: number;
    topK?: number;
    parallelism?: number;
    autonomy?: AutonomyPolicy;
    reviewer?: DecisionReviewer;
    proposal?: ProposalPrompt;
    onAbstain?: "block" | "verify-top";
    budget?: SearchBudgetLimits;
  };
}


export const RUN_LEASE_TTL_MS = 30_000;

export function runLeasePath(runsDir: string, runId: string): string {
  return join(runsDir, `${runId}.lease.json`);
}

async function writeLease(path: string, lease: RunLease): Promise<void> {
  // Write-then-rename so a reader never sees a half-written lease.
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(lease) + "\n", "utf8");
  await rename(temp, path);
}

/** Reads a lease; undefined when absent or malformed (fails closed to "not live"). */
export async function readRunLease(path: string): Promise<RunLease | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<RunLease>;
    if (
      value.schema !== "lattice.run-lease/v1" ||
      typeof value.pid !== "number" ||
      typeof value.host !== "string" ||
      typeof value.heartbeatAt !== "string" ||
      typeof value.ttlMs !== "number"
    ) {
      return undefined;
    }
    return value as RunLease;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Liveness of an unfinished run. A lease is trusted only while fresh; on this
 * host a dead pid ends it at once, elsewhere expiry does. A missing or
 * malformed lease means the holder cannot be shown alive.
 */
export function leaseLiveness(
  lease: RunLease | undefined,
  now = Date.now(),
  thisHost = hostname(),
): Exclude<RunLiveness, "unknown"> {
  if (!lease) return "interrupted";
  const heartbeat = Date.parse(lease.heartbeatAt);
  if (!Number.isFinite(heartbeat) || heartbeat + lease.ttlMs < now) return "interrupted";
  if (lease.host === thisHost && !processAlive(lease.pid)) return "interrupted";
  return "running";
}

/** Holds a run's lease from just before `run.started` until its terminal event. */
class RunLeaseHolder {
  private timer?: NodeJS.Timeout;
  private renewing: Promise<void> = Promise.resolve();
  private readonly acquiredAt = new Date().toISOString();

  constructor(
    private readonly runId: string,
    private readonly path: string,
    private readonly ttlMs: number,
  ) {}

  private lease(): RunLease {
    return {
      schema: "lattice.run-lease/v1",
      runId: this.runId,
      pid: process.pid,
      host: hostname(),
      acquiredAt: this.acquiredAt,
      heartbeatAt: new Date().toISOString(),
      ttlMs: this.ttlMs,
    };
  }

  async acquire(): Promise<void> {
    await writeLease(this.path, this.lease());
    this.timer = setInterval(() => {
      this.renewing = this.renewing
        .then(() => writeLease(this.path, this.lease()))
        .catch(() => undefined);
    }, Math.max(50, Math.floor(this.ttlMs / 3)));
    this.timer.unref();
  }

  async release(): Promise<void> {
    clearInterval(this.timer);
    // Let an in-flight renewal land first, or it could recreate the lease.
    await this.renewing;
    await rm(this.path, { force: true });
  }
}

/**
 * Run the grounding verifier. A verifier whose binary does not exist (or fails to
 * spawn) is recorded as a failed command — exit 127, the POSIX convention for
 * "command not found" — instead of crashing the run: Terminal-Bench's error
 * analysis found missing executables are the most common command failure, and a
 * harness must treat them as evidence, not exceptions.
 */
export async function runVerifier(spec: CommandSpec): Promise<CommandResult> {
  try {
    return await runCommand(spec);
  } catch (error) {
    return {
      command: spec.command,
      args: spec.args ?? [],
      cwd: spec.cwd ?? process.cwd(),
      exitCode: 127,
      signal: null,
      stdout: "",
      stderr: String(error),
      durationMs: 0,
      timedOut: false,
      outputTruncated: false,
    };
  }
}

class JsonlEventLog {
  private seq = 0;

  constructor(
    private readonly runId: string,
    readonly path: string,
    private readonly onEvent?: (event: RunEvent) => void,
    private readonly lease?: RunLeaseHolder,
  ) {}

  async append<T>(type: RunEvent<T>["type"], payload: T): Promise<void> {
    const event: RunEvent<T> = {
      seq: ++this.seq,
      runId: this.runId,
      at: new Date().toISOString(),
      type,
      payload,
    };
    // The lease exists before run.started, so no reader sees a started run
    // without one, and it is released only after the terminal event is down.
    if (type === "run.started") await this.lease?.acquire();
    try {
      await appendFile(this.path, JSON.stringify(event) + "\n", "utf8");
    } finally {
      if (type === "run.completed" || type === "run.failed") await this.lease?.release();
    }
    try {
      this.onEvent?.(event);
    } catch {
      // Observers must never break the run or its log.
    }
  }
}

function evidence(
  kind: EvidenceRef["kind"],
  source: string,
  summary: string,
  verified = true,
): EvidenceRef {
  return {
    id: `ev:${digest(`${kind}\0${source}\0${summary}`).slice(0, 20)}`,
    kind,
    verified,
    source,
    summary,
    createdAt: new Date().toISOString(),
  };
}

export async function runTask(
  task: string,
  options: RunTaskOptions = {},
): Promise<RunResult> {
  const trimmed = task.trim();
  if (!trimmed) throw new Error("Task must not be empty");
  if (options.plan && (options.search || options.verifyCommand)) {
    throw new Error("Planning cannot run search or verification commands");
  }

  const cwd = resolve(options.cwd ?? process.cwd());
  const latticeDir = resolve(options.latticeDir ?? join(cwd, ".lattice"));
  const runId = randomUUID();
  const runsDir = join(latticeDir, "runs");
  await mkdir(runsDir, { recursive: true });

  const log = new JsonlEventLog(
    runId,
    join(runsDir, `${runId}.jsonl`),
    options.onEvent,
    new RunLeaseHolder(
      runId,
      runLeasePath(runsDir, runId),
      options.leaseTtlMs ?? RUN_LEASE_TTL_MS,
    ),
  );
  await log.append("run.started", {
    task: trimmed,
    cwd,
    ...(options.intent ? { intent: options.intent } : {}),
    ...(options.permissions ? { permissions: options.permissions } : {}),
    ...(options.lineage ? { lineage: options.lineage } : {}),
  });

  try {
    await log.append("tool.started", {
      tool: "repository.snapshot",
      cwd,
    });
    const snapshot = await collectRepositorySnapshot(cwd);
    await log.append("tool.completed", {
      tool: "repository.snapshot",
      snapshot,
    });

    const repoSummary = [
      `source=${snapshot.source}`,
      snapshot.revision ? `revision=${snapshot.revision}` : "revision=unknown",
      snapshot.dirty === undefined ? undefined : `dirty=${snapshot.dirty}`,
      `tracked_files=${snapshot.trackedFiles.length}`,
    ]
      .filter(Boolean)
      .join(" ");

    const repositoryEvidence = evidence(
      "repository",
      snapshot.source === "git" ? "git" : "filesystem",
      repoSummary,
    );

    let tap: TapPacket = {
      version: TAP_VERSION,
      runId,
      task: trimmed,
      repo: { root: cwd, revision: snapshot.revision },
      objectives: [trimmed],
      constraints: [],
      context: [
        `repo:${snapshot.source}`,
        `files:${snapshot.trackedFiles.slice(0, 80).join(",")}`,
      ],
      hypotheses: [],
      candidateActions: [],
      evidence: [repositoryEvidence],
      uncertainties: snapshot.revision ? [] : ["repository revision unavailable"],
      verification: [],
      budget: { maxRounds: 8 },
      childRunIds: [],
    };

    if (options.plan) {
      const sources = await readPlanSources(cwd, options.plan.files);
      tap.context = sources.context;
      tap.evidence.push(...sources.evidence);
      tap.constraints.push("Planning only: no implementation, agents or verification commands");
      tap.uncertainties.push("Source excerpts are bounded; generated advice requires review and implementation checks");
      tap.budget = { maxRounds: 1 };
    }

    if (options.verifyCommand) {
      const command = {
        ...options.verifyCommand,
        cwd: options.verifyCommand.cwd ?? cwd,
      };

      await log.append("tool.started", {
        tool: "command",
        command: command.command,
        args: command.args ?? [],
      });

      const result = await (options.commandRunner ?? runVerifier)(command);
      await log.append("tool.completed", {
        tool: "command",
        result,
      });

      const source = [result.command, ...result.args].join(" ");
      const summary = [
        `exit=${result.exitCode ?? "null"}`,
        `timeout=${result.timedOut}`,
        `duration_ms=${Math.round(result.durationMs)}`,
        result.outputTruncated ? "output=truncated" : undefined,
        result.stdout.trim()
          ? `stdout=${result.stdout.trim().slice(0, 500)}`
          : undefined,
        result.stderr.trim()
          ? `stderr=${result.stderr.trim().slice(0, 500)}`
          : undefined,
      ]
        .filter(Boolean)
        .join(" ");

      // Exit 127 is the POSIX "command not found" (or a spawn failure we
      // normalized): the verifier never actually ran, so its result is not
      // objective evidence even though it looks like a completed command.
      const ran = result.exitCode !== null && !result.timedOut && result.exitCode !== 127;
      const commandEvidence = evidence("command", source, summary, ran);
      tap.evidence.push(commandEvidence);
      tap.verification.push(commandEvidence.id);
    }

    if (options.verifier) {
      await log.append("tool.started", {
        tool: options.verifier.tool,
        ...options.verifier.describe(),
      });
      const verification = await options.verifier.verify(cwd);
      await log.append("tool.completed", {
        tool: verification.tool,
        passed: verification.passed,
        summary: verification.summary,
        record: verification.record,
      });
      tap.evidence.push(...verification.evidence);
      tap.verification.push(...verification.evidence.map((item) => item.id));
    }

    await log.append("tap.created", tap);

    let searchOutcome: RunResult["search"];
    let summary =
      `Lattice grounded the task in ${tap.evidence.length} evidence record(s) before model reasoning.`;

    if (options.plan) {
      options.signal?.throwIfAborted();
      await log.append("tool.started", { tool: "plan.generate" });
      const generated = await options.plan.generator.generate({
        system: PLAN_SYSTEM,
        prompt: trimmed,
        context: tap.context,
        temperature: 0.2,
        maxTokens: 4096,
      });
      options.signal?.throwIfAborted();
      if (!generated.text.trim()) throw new Error("Planner returned an empty draft");
      await log.append("tool.completed", { tool: "plan.generate", ...generated });
      summary = `Draft plan — model-generated; implementation and validation have not run.\n\n${generated.text.trim()}`;
      tap.evidence.push(evidence("model", generated.identity.model ?? generated.identity.provider, summary, false));
      await log.append("tap.updated", tap);
    }

    if (options.search) {
      const searchResult = await runSearchLoop({
        tap,
        generator: options.search.generator,
        decision: options.search.decision,
        executor: options.search.executor,
        maxRounds: options.search.maxRounds,
        candidatesPerRound: options.search.candidatesPerRound,
        topK: options.search.topK,
        parallelism: options.search.parallelism,
        autonomy: options.search.autonomy,
        reviewer: options.search.reviewer,
        proposal: options.search.proposal,
        onAbstain: options.search.onAbstain,
        budget: options.search.budget,
        signal: options.signal,
        onTrace: async (event) => {
          if (
            event.type === "candidates.generated" ||
            event.type === "candidates.rejected" ||
            event.type === "decision.framed"
          ) {
            await log.append("decision.requested", {
              round: event.round,
              event,
            });
          } else if (
            event.type === "decision.completed" ||
            event.type === "decision.overridden" ||
            event.type === "decision.review.requested" ||
            event.type === "decision.review.completed"
          ) {
            await log.append("decision.completed", event);
          } else if (event.type === "experiment.started") {
            await log.append("tool.started", {
              tool: "experiment",
              round: event.round,
              candidate: event.candidate,
            });
          } else if (event.type === "budget.exhausted") {
            await log.append("budget.exhausted", event);
          } else {
            await log.append("tool.completed", {
              tool: "experiment",
              round: event.round,
              outcome: event.outcome,
            });
          }
        },
      });

      tap = searchResult.tap;
      searchOutcome = {
        status: searchResult.status,
        rounds: searchResult.rounds,
        selected: searchResult.selected,
      };
      await log.append("tap.updated", tap);
      summary =
        `Lattice search ${searchResult.status} after ${searchResult.rounds} round(s); ` +
        `${tap.evidence.length} evidence record(s) retained.`;
    }

    await log.append("run.completed", { summary });

    return {
      runId,
      status: "completed",
      summary,
      tap,
      eventLogPath: log.path,
      ...(searchOutcome ? { search: searchOutcome } : {}),
    };
  } catch (error) {
    await log.append("run.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export * from "./adaptive.js";
export * from "@lattice/orchestrator";
