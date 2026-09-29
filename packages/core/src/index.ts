import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  TAP_VERSION,
  type RunEvent,
  type RunResult,
  type TapPacket,
} from "@lattice/protocol";

export interface RunTaskOptions {
  cwd?: string;
  latticeDir?: string;
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

  const tap: TapPacket = {
    version: TAP_VERSION,
    runId,
    task: trimmed,
    repo: { root: cwd },
    objectives: [trimmed],
    constraints: [],
    context: [],
    hypotheses: [],
    candidateActions: [],
    evidence: [],
    uncertainties: [],
    verification: [],
    budget: { maxRounds: 8 },
    childRunIds: [],
  };

  await log.append("tap.created", tap);

  // Milestone A intentionally stops before model/tool execution.
  // Subsequent issues replace this bootstrap completion with the
  // generate -> decide -> experiment -> verify loop.
  const summary =
    "Lattice created a replayable task packet. Provider and evidence execution are the next implementation slice.";

  await log.append("run.completed", { summary });

  return {
    runId,
    status: "completed",
    summary,
    tap,
    eventLogPath: log.path,
  };
}
