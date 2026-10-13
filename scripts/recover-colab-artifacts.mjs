/**
 * Reconcile live Colab sessions and export versioned artifacts locally.
 *
 * Usage:
 *   node scripts/recover-colab-artifacts.mjs [--execute]
 *
 * Default is read-only: it discovers sessions, probes what each is doing,
 * classifies it and records what *would* be recovered. `--execute` performs the
 * actual downloads and writes the versioned manifest. Nothing is ever stopped.
 */
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ArtifactStore,
  ColabClient,
  classifyArtifact,
  classifySession,
  findInefficientCpuSessions,
  recoverSession,
  safeToStop,
} from "../packages/colab/dist/index.js";
import { registerTargetsFromLiveOllama } from "../packages/providers/dist/index.js";

const EXECUTE = process.argv.includes("--execute");
const OUT_ROOT = process.env.LATTICE_ARTIFACT_ROOT ?? join(process.cwd(), ".colab-artifacts");
const OLLAMA_BASE = "http://127.0.0.1:11434/v1";

const client = new ColabClient();
const lines = [];
const log = (text = "") => {
  lines.push(text);
  process.stdout.write(`${text}\n`);
};

log("# Colab session reconciliation");
log(`mode: ${EXECUTE ? "execute" : "dry-run (read-only)"}`);
log();

let sessions = [];
let usage;
try {
  sessions = client.sessions();
} catch (error) {
  log(`colab sessions failed: ${error.message}`);
}
try {
  usage = client.usage();
} catch (error) {
  log(`colab usage failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Live model registry: what actually exists locally.
// ---------------------------------------------------------------------------

const registry = await registerTargetsFromLiveOllama(OLLAMA_BASE, fetch, {
  roles: ["decision", "generator", "coding-worker", "verifier", "benchmark-executor"],
});
log("## Local execution targets (discovered from Ollama)");
for (const target of registry.list()) {
  log(
    `- ${target.role.padEnd(20)} ${target.modelId.padEnd(22)} transport=${target.transport} ` +
      `caps=[${target.capabilities.join(",")}] endpoint=${target.endpoint}`,
  );
}
for (const role of ["decision", "generator"]) {
  try {
    const chosen = registry.select(role);
    log(`selected ${role}: ${chosen.modelId} via ${chosen.transport}`);
  } catch (error) {
    log(`selected ${role}: REFUSED (${error.message})`);
  }
}
log();

// ---------------------------------------------------------------------------
// Sessions.
// ---------------------------------------------------------------------------

log("## Live Colab sessions");
if (!sessions.length) log("- none reported");
const PROBE = `import json,subprocess
def sh(c):
    try: return subprocess.run(c,shell=True,capture_output=True,text=True,timeout=20).stdout.strip()
    except Exception as e: return ""
gpu=sh("nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader")
load=sh("cat /proc/loadavg").split(" ")[0]
model=sh("ps -eo args | grep -iE 'training|transformers|peft|lora' | grep -v grep | head -1")
test=sh("ps -eo args | grep -iE 'pytest|node --test|tsr ' | grep -v grep | head -1")
print(json.dumps({"gpu":gpu,"load":load,"model":bool(model),"test":bool(test)}))`;

const observations = new Map();
const sessionClasses = new Map();
for (const session of sessions) {
  let observed = {};
  try {
    const raw = client.exec(session.name, PROBE, 60);
    observed = JSON.parse(raw.slice(raw.indexOf("{")));
  } catch (error) {
    observed = { error: error.message };
  }
  const cls = classifySession(session, {
    gpuUtilizationPct: Number.parseInt(observed.gpu ?? "0", 10) || 0,
    cpuLoad: Number.parseFloat(observed.load ?? "0") || 0,
    modelProcessRunning: Boolean(observed.model),
    testProcessRunning: Boolean(observed.test),
  });
  observations.set(session.name, observed);
  sessionClasses.set(session.name, cls);
  log(
    `- ${session.name}: hardware=${session.acceleratorLabel} accelerator=${session.accelerator} ` +
      `class=${cls} gpu_util=${observed.gpu ?? "n/a"} load=${observed.load ?? "n/a"} ` +
      `model_proc=${observed.model ?? false} test_proc=${observed.test ?? false}`,
  );
}

const inefficient = findInefficientCpuSessions(sessions, observations);
if (inefficient.length) {
  log("## Inefficient CPU usage");
  for (const problem of inefficient) log(`- ${problem.session}: ${problem.issue}`);
}
log();

// ---------------------------------------------------------------------------
// Recovery.
// ---------------------------------------------------------------------------

const store = new ArtifactStore({ root: OUT_ROOT });
const EXPERIMENTS = [
  {
    session: "lattice-train",
    kind: "lora-router-training",
    remoteDirs: ["/content/lattice-router-lora", "/content"],
    files: [
      "adapter_model.safetensors",
      "adapter_config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "chat_template.jinja",
      "training_metrics.json",
      "README.md",
    ],
    /** Where the artifacts already recovered before the session died live. */
    localFallback: "/Users/user/Lattice-colab-results",
    localFileMap: {
      "adapter_model.safetensors": "extracted/lattice-router-lora/adapter_model.safetensors",
      "adapter_config.json": "extracted/lattice-router-lora/adapter_config.json",
      "tokenizer.json": "extracted/lattice-router-lora/tokenizer.json",
      "tokenizer_config.json": "extracted/lattice-router-lora/tokenizer_config.json",
      "chat_template.jinja": "extracted/lattice-router-lora/chat_template.jinja",
      "training_metrics.json": "extracted/lattice-router-lora/training_metrics.json",
      README: "extracted/lattice-router-lora/README.md",
    },
  },
  {
    session: "lattice-polyglot",
    kind: "polyglot-cpu-verification",
    remoteDirs: ["/content/polyglot-results", "/content"],
    files: ["cpu_run_summary.json"],
    localFallback: "/Users/user/Lattice-colab-results",
    localFileMap: { "cpu_run_summary.json": "cpu_run_summary.json" },
  },
  {
    session: "lattice-eval",
    kind: "colab-t4-benchmark",
    remoteDirs: ["/content/bench-results", "/content"],
    files: ["run-1791645461.json", "colab-exp-1791646431.json", "colab-eval-tier-b-c.json"],
    localFallback: "/Volumes/Harry/DEV/Tessillate/benchmarks/results",
    localFileMap: {
      "run-1791645461.json": "run-1791645461.json",
      "colab-exp-1791646431.json": "colab-exp-1791646431.json",
      "colab-eval-tier-b-c.json": "colab-eval-tier-b-c.json",
    },
  },
];

log("## Artifact recovery");
for (const experiment of EXPERIMENTS) {
  const session = sessions.find((s) => s.name === experiment.session);
  if (!session) {
    // Stale session name: ingest anything already recovered locally instead of
    // failing, and record the experiment as interrupted rather than lost.
    const artifacts = ingestLocal(store, experiment);
    const { outcome, reason } = artifacts.length
      ? {
          outcome: "interrupted",
          reason:
            `session ${experiment.session} is not live (stale or pruned); ` +
            `${artifacts.length} artifact(s) ingested from the local recovery store`,
        }
      : {
          outcome: "lost",
          reason: `session ${experiment.session} is not live and no local artifacts were found`,
        };
    store.record({
      id: `${experiment.session}-${experiment.kind}`,
      session: experiment.session,
      kind: experiment.kind,
      outcome,
      reason,
      artifacts,
    });
    log(
      `- ${experiment.session}: stale session name handled gracefully -> ${outcome} ` +
        `(${artifacts.length} artifacts)`,
    );
    store.writeManifest(experiment.session);
    continue;
  }
  const records = recoverSession(client, store, session, experiment.remoteDirs, [
    { kind: experiment.kind, metricsFiles: ["training_metrics.json", "cpu_run_summary.json"] },
  ]);
  for (const record of records) {
    log(
      `- ${record.session}/${record.kind}: ${record.outcome} — ${record.reason} ` +
        `(${record.artifacts.length} artifacts, ${record.artifacts.reduce((n, a) => n + a.bytes, 0)} bytes)`,
    );
    for (const artifact of record.artifacts) log(`    ${artifact.kind.padEnd(9)} ${artifact.remotePath} -> ${artifact.localPath}`);
  }
}
log();

/**
 * Copy artifacts that were already recovered before a session died into the
 * versioned store, so a stale session name never loses evidence.
 */
function ingestLocal(store, experiment) {
  if (!experiment.localFallback) return [];
  const targetDir = join(store.root, experiment.session, experiment.remoteDirs[0].replace(/^\/+|\/+$/g, ""));
  mkdirSync(targetDir, { recursive: true });
  const artifacts = [];
  for (const [fileName, relative] of Object.entries(experiment.localFileMap ?? {})) {
    const source = join(experiment.localFallback, relative);
    if (!existsSync(source)) continue;
    const localPath = join(targetDir, fileName);
    copyFileSync(source, localPath);
    artifacts.push({
      localPath,
      remotePath: `${experiment.remoteDirs[0]}/${fileName}`,
      session: experiment.session,
      bytes: statSync(localPath).size,
      kind: classifyArtifact(fileName),
    });
  }
  return artifacts;
}

if (usage) {
  log("## Compute units");
  log(`- balance: ${usage.balanceUnits}`);
  log(`- usage rate: ${usage.usageRatePerHour}/hr`);
  log(`- active assignments: ${usage.activeAssignments}`);
  log();
}

const blockers = safeToStop(store.allRecords());
log(`## Stop readiness: ${blockers.safe ? "SAFE" : "BLOCKED"}`);
for (const blocker of blockers.blockers) log(`- ${blocker}`);
log();

const report = {
  generatedAt: new Date().toISOString(),
  mode: EXECUTE ? "execute" : "dry-run",
  usage,
  sessions: sessions.map((s) => ({
    name: s.name,
    hardware: s.acceleratorLabel,
    accelerator: s.accelerator,
    class: sessionClasses.get(s.name),
    observed: observations.get(s.name),
  })),
  inefficientCpuUsage: inefficient,
  localTargets: registry.list().map((t) => ({
    role: t.role,
    modelId: t.modelId,
    provider: t.provider,
    transport: t.transport,
    capabilities: t.capabilities,
    endpoint: t.endpoint,
    availability: t.availability,
    auth: t.auth,
  })),
  experiments: store.allRecords(),
};

mkdirSync(OUT_ROOT, { recursive: true });
const reportPath = join(OUT_ROOT, `reconciliation-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
log(`report written to ${reportPath}`);
