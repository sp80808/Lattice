#!/usr/bin/env node
import { runTask } from "@lattice/core";
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
  console.log("Config discovery:");
  console.log("  .lattice/config.json");
  console.log("  lattice.config.json");
  console.log("  $LATTICE_CONFIG");
  process.exit(0);
}

try {
  const loaded = await loadLatticeConfig(process.cwd(), configPath);
  const options = loaded ? createRunTaskOptions(loaded.config) : {};

  if (loaded) {
    console.log(`config: ${loaded.path}`);
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
