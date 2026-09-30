import { parseArgs, type ParseArgsConfig } from "node:util";
import { resolve } from "node:path";
import { buildStatsReport, formatStatsReport } from "@lattice/analytics";
import { serveMcpStdio } from "@lattice/mcp";
import {
  formatMiningReport,
  mineLedger,
  writeMiningProposals,
} from "@lattice/mining";
import {
  buildPolicySimulation,
  formatPolicySimulation,
} from "@lattice/policy";
import type { DoctorStatus, RunDetail, RunEvent, RunSummary } from "@lattice/protocol";
import { startLatticeServer } from "@lattice/server";
import {
  buildInitConfig,
  detectVerifyCommand,
  executeTask,
  followRunEvents,
  getRun,
  getRunEvents,
  INIT_PRESETS,
  listRuns,
  loadConfig,
  parseCommandLine,
  runDoctor,
  writeConfig,
  type InitPreset,
} from "@lattice/service";
import { cliReviewer } from "./reviewer.js";

/** Thrown for bad invocations; the dispatcher prints usage and exits 2. */
export class UsageError extends Error {}

type Options = NonNullable<ParseArgsConfig["options"]>;

const common = {
  cwd: { type: "string", short: "C" },
  json: { type: "boolean" },
} satisfies Options;

function parse<T extends Options>(args: string[], options: T) {
  try {
    return parseArgs({ args, options: { ...common, ...options }, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function cwdOf(values: { cwd?: string }): string {
  return resolve(values.cwd ?? process.cwd());
}

function truncate(text: string | undefined, width: number): string {
  const value = (text ?? "").replace(/\s+/g, " ");
  return value.length > width ? value.slice(0, width - 1) + "…" : value;
}

function when(iso: string | undefined): string {
  return iso ? iso.replace("T", " ").slice(0, 19) : "-";
}

// ---------------------------------------------------------------------------

export async function runCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    config: { type: "string" },
    observe: { type: "boolean" },
  });
  const task = positionals.join(" ").trim();
  if (!task) throw new UsageError("run requires a task");

  let outcome;
  try {
    outcome = await executeTask(task, {
      cwd: cwdOf(values),
      configPath: values.config,
      mode: values.observe ? "observe" : "configured",
      reviewer: cliReviewer,
    });
  } catch (error) {
    console.error("hint: `lattice doctor` checks model endpoints, agent and verifier setup");
    throw error;
  }
  const { result } = outcome;

  if (values.json) {
    printJson({ ...result, mode: outcome.mode, runtimeMode: outcome.runtimeMode, configPath: outcome.configPath });
    return 0;
  }
  console.log(`config: ${outcome.configPath ?? "none (evidence-only bootstrap mode)"}`);
  console.log(`mode: ${outcome.runtimeMode}`);
  console.log(`run: ${result.runId}`);
  console.log(result.summary);
  console.log(`evidence: ${result.tap.evidence.length}`);
  console.log(`events: ${result.eventLogPath}`);
  return 0;
}

export async function initCommand(args: string[]): Promise<number> {
  const { values } = parse(args, {
    preset: { type: "string", short: "p" },
    model: { type: "string", short: "m" },
    "base-url": { type: "string" },
    "api-key-env": { type: "string" },
    agent: { type: "string" },
    verify: { type: "string" },
    "no-verify": { type: "boolean" },
    autonomy: { type: "string" },
    force: { type: "boolean", short: "f" },
    print: { type: "boolean" },
  });
  const cwd = cwdOf(values);

  const preset = (values.preset ?? "ollama") as InitPreset;
  if (!INIT_PRESETS.includes(preset)) {
    throw new UsageError(`--preset must be one of: ${INIT_PRESETS.join(", ")}`);
  }
  if (values.agent !== undefined && values.agent !== "qwen-code" && values.agent !== "opencode") {
    throw new UsageError("--agent must be qwen-code or opencode");
  }
  const autonomy = values.autonomy;
  if (autonomy !== undefined && autonomy !== "autopilot" && autonomy !== "supervised" && autonomy !== "manual") {
    throw new UsageError("--autonomy must be autopilot, supervised or manual");
  }

  const verify = values["no-verify"]
    ? undefined
    : values.verify
      ? parseCommandLine(values.verify)
      : await detectVerifyCommand(cwd);

  const plan = buildInitConfig({
    preset,
    model: values.model,
    baseUrl: values["base-url"],
    apiKeyEnv: values["api-key-env"],
    agent: values.agent,
    verify,
    autonomy,
  });

  if (values.print) {
    printJson(plan.config);
    for (const warning of plan.warnings) console.error(`warning: ${warning}`);
    return 0;
  }

  const path = await writeConfig(plan.config, { cwd, force: values.force });
  if (values.json) {
    printJson({ path, config: plan.config, warnings: plan.warnings });
    return 0;
  }
  console.log(`wrote ${path}`);
  console.log(`  mode: ${plan.config.mode}`);
  if (plan.config.model) console.log(`  model: ${plan.config.model.model} @ ${plan.config.model.baseUrl}`);
  if (plan.config.agent) console.log(`  agent: ${plan.config.agent.preset}`);
  console.log(
    `  verify: ${plan.config.verify ? [plan.config.verify.command, ...(plan.config.verify.args ?? [])].join(" ") : "none"}`,
  );
  for (const warning of plan.warnings) console.log(`warning: ${warning}`);
  console.log("");
  console.log("next: lattice doctor");
  return 0;
}

const MARK: Record<DoctorStatus, string> = { ok: "✓", warn: "!", fail: "✗", skip: "-" };

export async function doctorCommand(args: string[]): Promise<number> {
  const { values } = parse(args, {
    config: { type: "string" },
    offline: { type: "boolean" },
  });
  const report = await runDoctor({
    cwd: cwdOf(values),
    configPath: values.config,
    network: !values.offline,
  });
  if (values.json) {
    printJson(report);
  } else {
    for (const check of report.checks) {
      console.log(`${MARK[check.status]} ${check.id.padEnd(18)} ${check.message}`);
      if (check.hint && check.status !== "ok") console.log(`  ${"".padEnd(18)} → ${check.hint}`);
    }
    console.log("");
    console.log(report.ok ? "Lattice is ready." : "Lattice has problems that need fixing (✗).");
  }
  return report.ok ? 0 : 1;
}

function runRow(run: RunSummary): string {
  return [
    run.runId.slice(0, 8),
    run.status.padEnd(10),
    when(run.startedAt),
    `ev=${run.evidence} dec=${run.decisions} exp=${run.experiments}`.padEnd(20),
    truncate(run.task, 60),
  ].join("  ");
}

export async function runsCommand(args: string[]): Promise<number> {
  const { values } = parse(args, { limit: { type: "string", short: "n" } });
  const limit = values.limit === undefined ? 20 : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError("--limit must be a positive integer");

  const runs = await listRuns({ cwd: cwdOf(values), limit });
  if (values.json) {
    printJson(runs);
  } else if (runs.length === 0) {
    console.log('no runs yet — try: lattice run "inspect this repository"');
  } else {
    for (const run of runs) console.log(runRow(run));
  }
  return 0;
}

function eventLine(event: RunEvent): string {
  const payload = event.payload as Record<string, unknown> | undefined;
  const detail = typeof payload?.tool === "string" ? payload.tool : typeof payload?.type === "string" ? payload.type : "";
  return `${String(event.seq).padStart(4)}  ${when(event.at)}  ${event.type.padEnd(20)} ${detail}`;
}

function printRun(run: RunDetail): void {
  console.log(`run:      ${run.runId}`);
  console.log(`status:   ${run.status}`);
  console.log(`task:     ${run.task ?? "-"}`);
  console.log(`cwd:      ${run.cwd ?? "-"}`);
  console.log(`started:  ${when(run.startedAt)}   ended: ${when(run.endedAt)}`);
  if (run.tap?.repo?.revision) console.log(`revision: ${run.tap.repo.revision}`);
  if (run.summary) console.log(`summary:  ${run.summary}`);
  if (run.error) console.log(`error:    ${run.error}`);
  console.log(`counts:   events=${run.events} decisions=${run.decisions} experiments=${run.experiments}`);

  const evidence = run.tap?.evidence ?? [];
  if (evidence.length) {
    console.log("evidence:");
    for (const item of evidence) {
      console.log(`  ${item.verified ? "✓" : "?"} ${item.kind.padEnd(10)} ${truncate(item.summary, 100)}`);
    }
  }
  const uncertainties = run.tap?.uncertainties ?? [];
  if (uncertainties.length) {
    console.log("uncertainties:");
    for (const item of uncertainties) console.log(`  - ${item}`);
  }
  console.log(`log:      ${run.logPath}`);
}

export async function showCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    events: { type: "boolean" },
    follow: { type: "boolean", short: "f" },
  });
  const cwd = cwdOf(values);
  const id = positionals[0] ?? "latest";

  if (values.follow) {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    for await (const event of followRunEvents(id, cwd, { signal: controller.signal })) {
      if (values.json) {
        console.log(JSON.stringify(event));
      } else {
        console.log(eventLine(event));
      }
    }
    if (!values.json && !controller.signal.aborted) {
      console.log("");
      printRun(await getRun(id, cwd));
    }
    return 0;
  }

  if (values.events) {
    const events = await getRunEvents(id, cwd);
    if (values.json) {
      printJson(events);
    } else {
      for (const event of events) console.log(eventLine(event));
    }
    return 0;
  }

  const run = await getRun(id, cwd);
  if (values.json) printJson(run);
  else printRun(run);
  return 0;
}

export async function configCommand(args: string[]): Promise<number> {
  const { values } = parse(args, { config: { type: "string" } });
  const loaded = await loadConfig(cwdOf(values), values.config);
  if (values.json) {
    printJson(loaded ?? null);
  } else if (!loaded) {
    console.log("no config found (searched $LATTICE_CONFIG, .lattice/config.json, lattice.config.json)");
    console.log("create one with: lattice init");
  } else {
    console.log(`# ${loaded.path}`);
    printJson(loaded.config);
  }
  return 0;
}

export async function serveCommand(args: string[]): Promise<number> {
  const { values } = parse(args, {
    port: { type: "string", short: "p" },
    token: { type: "string" },
    origin: { type: "string", multiple: true },
  });
  const port = Number(values.port ?? process.env.LATTICE_PORT ?? 4774);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError("--port must be 0-65535");

  const started = await startLatticeServer({
    port,
    cwd: cwdOf(values),
    token: values.token ?? (process.env.LATTICE_DAEMON_TOKEN || undefined),
    allowedOrigins: values.origin,
  });
  console.log(`Lattice daemon listening on ${started.url}`);
  await new Promise<void>((resolveStop) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolveStop());
  });
  await started.close();
  return 0;
}

export async function mcpCommand(args: string[]): Promise<number> {
  const { values } = parse(args, {});
  await serveMcpStdio({ cwd: cwdOf(values) });
  return 0;
}

// ---------------------------------------------------------------------------
// Replay analytics (flag handling unchanged from the original CLI).

export async function policySimCommand(simArgs: string[]): Promise<number> {
  const candidatePath = simArgs[0];
  if (!candidatePath || candidatePath.startsWith("--")) {
    throw new UsageError("policy-sim requires a candidate policy JSON path");
  }

  const json = simArgs.includes("--json");
  const holdoutIndex = simArgs.indexOf("--holdout");
  const holdout = holdoutIndex >= 0 ? Number(simArgs[holdoutIndex + 1] ?? "0.2") : 0.2;
  const againstIndex = simArgs.indexOf("--against");
  const paths: string[] = [];
  if (againstIndex >= 0) {
    for (let index = againstIndex + 1; index < simArgs.length; index++) {
      const value = simArgs[index]!;
      if (value.startsWith("--")) break;
      paths.push(value);
    }
  }

  const report = await buildPolicySimulation(candidatePath, paths, holdout);
  console.log(json ? JSON.stringify(report, null, 2) : formatPolicySimulation(report));
  return 0;
}

export async function mineCommand(mineArgs: string[]): Promise<number> {
  const json = mineArgs.includes("--json");
  const valueAfter = (flag: string): string | undefined => {
    const index = mineArgs.indexOf(flag);
    return index >= 0 ? mineArgs[index + 1] : undefined;
  };
  const out = valueAfter("--out");
  const maxRules = Number(valueAfter("--rules") ?? "5");
  const maxTiles = Number(valueAfter("--tiles") ?? "5");
  const minRuleSupport = Number(valueAfter("--min-support") ?? "3");
  const consumed = new Set<string>();
  for (const flag of ["--out", "--rules", "--tiles", "--min-support"]) {
    const index = mineArgs.indexOf(flag);
    if (index >= 0) {
      consumed.add(flag);
      if (mineArgs[index + 1]) consumed.add(mineArgs[index + 1]!);
    }
  }
  consumed.add("--json");
  const paths = mineArgs.filter((arg) => !consumed.has(arg));

  const report = await mineLedger(paths, { maxRules, maxTiles, minRuleSupport });
  if (out) {
    const files = await writeMiningProposals(report, out);
    if (!json) console.log(`wrote: ${files.join(", ")}`);
  }
  console.log(json ? JSON.stringify(report, null, 2) : formatMiningReport(report));
  return 0;
}

export async function statsCommand(statsArgs: string[]): Promise<number> {
  const json = statsArgs.includes("--json");
  const paths = statsArgs.filter((arg) => arg !== "--json");
  const report = await buildStatsReport(paths);
  console.log(json ? JSON.stringify(report, null, 2) : formatStatsReport(report));
  return 0;
}
