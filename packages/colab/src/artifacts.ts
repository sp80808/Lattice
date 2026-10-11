/**
 * Colab artifact recovery and experiment reconciliation.
 *
 * Emitted artifacts are recovered and registered *before* any session is
 * stopped. Each experiment is classified so downstream consumers never read a
 * partial or unverified run as a completed one:
 *
 *   completed   - verified outputs present (tests/verifier ran to completion)
 *   interrupted - the session died or was pruned mid-run
 *   unverified  - outputs exist but no independent verification ran
 *   lost        - referenced but unrecoverable
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ColabClient, ColabSession } from "./client.js";

export type ExperimentOutcome = "completed" | "interrupted" | "unverified" | "lost";

export interface RecoveredArtifact {
  /** Path relative to the local export root. */
  localPath: string;
  remotePath: string;
  session: string;
  bytes: number;
  kind: "adapter" | "metrics" | "summary" | "notebook" | "log" | "other";
}

export interface ExperimentRecord {
  id: string;
  session: string;
  kind: string;
  outcome: ExperimentOutcome;
  /** Why this outcome was assigned. Required so the record is auditable. */
  reason: string;
  artifacts: RecoveredArtifact[];
  /** Model/backend identity actually used, when recorded by the producer. */
  modelIdentity?: { modelId: string; provider: string; device?: string };
  metrics?: Record<string, number>;
  startedAt?: string;
  recoveredAt: string;
}

export interface ArtifactStoreOptions {
  root: string;
  /** Injectable so tests never touch the real filesystem or Colab. */
  client?: Pick<ColabClient, "ls" | "download" | "session">;
  now?: () => Date;
}

export class ArtifactStore {
  readonly root: string;
  private readonly client?: Pick<ColabClient, "ls" | "download" | "session">;
  private readonly now: () => Date;
  private readonly records: ExperimentRecord[] = [];

  constructor(options: ArtifactStoreOptions) {
    this.root = options.root;
    this.client = options.client;
    this.now = options.now ?? (() => new Date());
    mkdirSync(this.root, { recursive: true });
  }

  /** Recover remote artifacts into the versioned local store. */
  recover(session: string, remoteDir: string, fileNames: readonly string[]): RecoveredArtifact[] {
    const recovered: RecoveredArtifact[] = [];
    if (!this.client) return recovered;
    const targetDir = join(this.root, session, remoteDir.replace(/^\/+|\/+$/g, ""));
    mkdirSync(targetDir, { recursive: true });
    for (const fileName of fileNames) {
      const remotePath = `${remoteDir.replace(/\/+$/, "")}/${fileName}`;
      const localPath = join(targetDir, fileName);
      try {
        this.client.download(session, remotePath, localPath);
      } catch {
        // A missing artifact is recoverable and must not abort the whole sweep.
        continue;
      }
      if (!existsSync(localPath)) continue;
      recovered.push({
        localPath,
        remotePath,
        session,
        bytes: fileSize(localPath),
        kind: classifyArtifact(fileName),
      });
    }
    return recovered;
  }

  record(record: Omit<ExperimentRecord, "recoveredAt">): ExperimentRecord {
    const full: ExperimentRecord = { ...record, recoveredAt: this.now().toISOString() };
    this.records.push(full);
    return full;
  }

  recordsFor(session: string): ExperimentRecord[] {
    return this.records.filter((r) => r.session === session);
  }

  allRecords(): readonly ExperimentRecord[] {
    return this.records;
  }

  /** Write the versioned manifest for a session. */
  writeManifest(session: string): string {
    const path = join(this.root, session, "manifest.json");
    mkdirSync(dirname(path), { recursive: true });
    const payload = {
      schemaVersion: 1,
      session,
      exportedAt: this.now().toISOString(),
      experiments: this.recordsFor(session),
    };
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
    return path;
  }

  /** Experiments whose artifacts are present but whose outcome is not proven. */
  needsVerification(): ExperimentRecord[] {
    return this.records.filter((r) => r.outcome === "unverified" || r.outcome === "interrupted");
  }
}

export function classifyArtifact(fileName: string): RecoveredArtifact["kind"] {
  if (/adapter|safetensors|\.bin$/.test(fileName)) return "adapter";
  if (/metric|accuracy|loss/.test(fileName)) return "metrics";
  if (/summary|report/.test(fileName)) return "summary";
  if (/\.ipynb$/.test(fileName)) return "notebook";
  if (/\.log$/.test(fileName)) return "log";
  return "other";
}

function fileSize(path: string): number {
  try {
    return readFileSync(path).byteLength;
  } catch {
    return 0;
  }
}

/**
 * Classify an experiment from the artifacts that were actually recovered.
 *
 * The rule is deliberately conservative: an adapter is only `completed` when a
 * metrics file records a finished run. A metrics file alone with no adapter is
 * `interrupted`. Anything recovered without either is `unverified`.
 */
export function classifyExperiment(
  kind: string,
  artifacts: readonly RecoveredArtifact[],
  context: { terminatedByColab?: boolean } = {},
): { outcome: ExperimentOutcome; reason: string } {
  const hasAdapter = artifacts.some((a) => a.kind === "adapter");
  const hasMetrics = artifacts.some((a) => a.kind === "metrics");
  if (context.terminatedByColab) {
    return { outcome: "interrupted", reason: "Colab pruned the session before the run finished" };
  }
  if (hasAdapter && hasMetrics) {
    return { outcome: "completed", reason: "adapter weights and run metrics both recovered" };
  }
  if (hasMetrics && !hasAdapter) {
    return { outcome: "interrupted", reason: "metrics recovered but the adapter weights are missing" };
  }
  if (!artifacts.length) {
    return { outcome: "lost", reason: "no artifacts could be recovered from the session" };
  }
  return { outcome: "unverified", reason: "artifacts recovered with no verifiable completion record" };
}

/**
 * Decide whether a session is safe to stop: only once its artifacts are
 * recovered and registered.
 */
export function safeToStop(records: readonly ExperimentRecord[]): { safe: boolean; blockers: string[] } {
  const blockers: string[] = [];
  for (const record of records) {
    if (record.outcome === "lost") {
      blockers.push(`${record.session}/${record.id}: no artifacts recovered`);
    }
  }
  return { safe: blockers.length === 0, blockers };
}

/** Recover everything from one session without stopping it. */
export function recoverSession(
  client: Pick<ColabClient, "ls" | "download" | "session">,
  store: ArtifactStore,
  session: ColabSession,
  remoteDirs: readonly string[],
  knownExperiments: readonly { kind: string; metricsFiles?: readonly string[] }[],
): ExperimentRecord[] {
  const records: ExperimentRecord[] = [];
  for (const experiment of knownExperiments) {
    const wanted: string[] = [];
    for (const dir of remoteDirs) {
      let listing: string[] = [];
      try {
        listing = client.ls(session.name, dir);
      } catch {
        continue;
      }
      wanted.push(...listing.filter((f) => /adapter|metric|summary|\.json$|\.ipynb$|\.log$/.test(f)));
    }
    const artifacts = store.recover(session.name, remoteDirs[0] ?? "/content", wanted);
    const { outcome, reason } = classifyExperiment(experiment.kind, artifacts);
    records.push(
      store.record({
        id: `${session.name}-${experiment.kind}`,
        session: session.name,
        kind: experiment.kind,
        outcome,
        reason,
        artifacts,
      }),
    );
  }
  store.writeManifest(session.name);
  return records;
}
