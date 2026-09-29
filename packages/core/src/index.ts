import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  collectRepositorySnapshot,
  digest,
  runCommand,
  type CommandSpec,
} from "@lattice/execution";
import {
  TAP_VERSION,
  type EvidenceRef,
  type RunEvent,
  type RunResult,
  type TapPacket,
} from "@lattice/protocol";

export interface RunTaskOptions {
  cwd?: string;
  latticeDir?: string;
  verifyCommand?: CommandSpec;
}

class JsonlEventLog {
  private seq = 0;

  constructor(
    private readonly runId: string,
    readonly path: string,
  ) {}

  async append<T>(type: RunEvent<T>["type"], payload: T): Promise<void> {
    const event: RunEvent<T> = {
      seq: ++this.seq,
      runId: this.runId,
      at: new Date().toISOString(),
      type,
      payload,
    };
    await appendFile(this.path, JSON.stringify(event) + "\n", "utf8");
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

  const log = new JsonlEventLog(runId, join(runsDir, `${runId}.jsonl`));
  await log.append("run.started", { task: trimmed, cwd });

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

  const tap: TapPacket = {
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

  await log.append("tap.created", tap);

  const summary =
    `Lattice grounded the task in ${tap.evidence.length} evidence record(s) before model reasoning.`;

  await log.append("run.completed", { summary });

  return {
    runId,
    status: "completed",
    summary,
    tap,
    eventLogPath: log.path,
  };
}
