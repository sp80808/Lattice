import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import {
  collectRepositorySnapshot,
  digest,
  runCommand,
  type CommandSpec,
} from "@lattice/execution";
import {
  runSearchLoop,
  type AutonomyPolicy,
  type DecisionReviewer,
  type ExperimentExecutor,
  type ProposalPrompt,
} from "@lattice/search";
import {
  TAP_VERSION,
  type EvidenceRef,
  type RunEvent,
  type RunResult,
  type DecisionProvider,
  type GeneratorProvider,
  type RunLease,
  type RunLiveness,
  type TapPacket,
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
  /** Structured verifier (e.g. `tsr witness`); its record is stored in the run log. */
  verifier?: Verifier;
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

  await log.append("run.started", { task: trimmed, cwd });

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

      const result = await runCommand(command);
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

      const commandEvidence = evidence(
        "command",
        source,
        summary,
        result.exitCode !== null && !result.timedOut,
      );
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
