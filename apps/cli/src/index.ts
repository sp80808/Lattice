#!/usr/bin/env node
import { runTask } from "@lattice/core";

const args = process.argv.slice(2);
const task = args.join(" ").trim();

if (!task) {
  console.log("Lattice — generate less, choose cheaply, verify everything.");
  console.log("");
  console.log('Usage: lattice "your coding task"');
  process.exit(0);
}

try {
  const result = await runTask(task);
  console.log(`run: ${result.runId}`);
  console.log(result.summary);
  console.log(`events: ${result.eventLogPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
