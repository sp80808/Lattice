#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runTask } from "@lattice/core";
import type { DecisionReviewer } from "@lattice/search";
import {
  createRunTaskOptions,
  loadLatticeConfig,
} from "@lattice/runtime";

const args = process.argv.slice(2);
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
