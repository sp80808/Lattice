#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { buildStatsReport, formatStatsReport } from "@lattice/analytics";
import { runTask } from "@lattice/core";
import {
  formatMiningReport,
  mineLedger,
  writeMiningProposals,
} from "@lattice/mining";
import type { DecisionReviewer } from "@lattice/search";
import {
  createRunTaskOptions,
  loadLatticeConfig,
} from "@lattice/runtime";

const args = process.argv.slice(2);

if (args[0] === "mine") {
  const mineArgs = args.slice(1);
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

  try {
    const report = await mineLedger(paths, {
      maxRules,
      maxTiles,
      minRuleSupport,
    });
    if (out) {
      const files = await writeMiningProposals(report, out);
      if (!json) console.log(`wrote: ${files.join(", ")}`);
    }
    console.log(json ? JSON.stringify(report, null, 2) : formatMiningReport(report));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  process.exit();
}

if (args[0] === "stats") {
  const statsArgs = args.slice(1);
  const json = statsArgs.includes("--json");
  const paths = statsArgs.filter((arg) => arg !== "--json");
  try {
    const report = await buildStatsReport(paths);
    console.log(json ? JSON.stringify(report, null, 2) : formatStatsReport(report));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  process.exit();
}

let configPath: string | undefined;
const taskParts: string[] = [];

for (let index = 0; index < args.length; index++) {
  const arg = args[index]!;
  if (arg === "--config") {
    const next = args[++index];
    if (!next) {
      console.error("--config requires a path");
      process.exit(2);
    }
    configPath = next;
  } else {
    taskParts.push(arg);
  }
}

const task = taskParts.join(" ").trim();

if (!task) {
  console.log("Lattice — generate less, choose cheaply, verify everything.");
  console.log("");
  console.log('Usage: lattice [--config path] "your coding task"');
  console.log("       lattice stats [--json] [run-file-or-directory ...]");
  console.log("       lattice mine [--json] [--out dir] [--rules N] [--tiles N] [run-path ...]");
  console.log("");
  console.log("Autonomy modes: autopilot | supervised | manual");
  console.log("Config discovery:");
  console.log("  .lattice/config.json");
  console.log("  lattice.config.json");
  console.log("  $LATTICE_CONFIG");
  process.exit(0);
}

const cliReviewer: DecisionReviewer = async (request) => {
  if (!input.isTTY || !output.isTTY) {
    return {
      action: "stop",
      note: "interactive review required but no TTY is available",
    };
  }

  console.log("");
  console.log(`Review required — round ${request.round}`);
  console.log(`Question: ${request.frame.question}`);
  console.log(`Reasons: ${request.reasons.join("; ")}`);
  console.log("Evidence:");
  for (const id of request.frame.evidenceIds) console.log(`  - ${id}`);
  console.log("Options:");
  request.frame.choices.forEach((choice, index) => {
    console.log(
      `  ${index + 1}. [${choice.id}] ${choice.label}${choice.detail ? ` — ${choice.detail}` : ""}`,
    );
  });
  console.log(`Model selection: ${request.decision.selected.join(", ")}`);

  const rl = createInterface({ input, output });
  try {
    const answer = (
      await rl.question(
        "Approve [Enter/a], replace with IDs [id1,id2], refine [r], or stop [s]: ",
      )
    ).trim();

    if (!answer || answer.toLowerCase() === "a") {
      return { action: "approve" };
    }
    if (answer.toLowerCase() === "r") {
      const note = await rl.question("Refinement note (optional): ");
      return { action: "refine", note: note.trim() || undefined };
    }
    if (answer.toLowerCase() === "s") {
      return { action: "stop" };
    }

    const selected = answer
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return {
      action: "replace",
      selected,
      note: "human-selected candidate override",
    };
  } finally {
    rl.close();
  }
};

try {
  const loaded = await loadLatticeConfig(process.cwd(), configPath);
  const options = loaded
    ? createRunTaskOptions(loaded.config, { reviewer: cliReviewer })
    : {};

  if (loaded) {
    console.log(`config: ${loaded.path}`);
    console.log(
      `autonomy: ${loaded.config.autonomy?.mode ?? "autopilot"}`,
    );
  } else {
    console.log("config: none (evidence-only bootstrap mode)");
  }

  const result = await runTask(task, options);
  console.log(`run: ${result.runId}`);
  console.log(result.summary);
  console.log(`evidence: ${result.tap.evidence.length}`);
  console.log(`events: ${result.eventLogPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
