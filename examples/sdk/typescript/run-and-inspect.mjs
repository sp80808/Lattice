#!/usr/bin/env node
// Drive the Lattice daemon from TypeScript/JavaScript with @lattice/sdk.
//
//   npm run build && node examples/sdk/typescript/run-and-inspect.mjs
//
// Uses $LATTICE_URL if a daemon is already running (`lattice serve`);
// otherwise starts one in-process on a free port against a demo project.
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LatticeApiError, LatticeClient } from "@lattice/sdk";
import { startLatticeServer } from "@lattice/server";

const here = dirname(fileURLToPath(import.meta.url));
const project = await mkdtemp(join(tmpdir(), "lattice-sdk-ts-"));
await cp(join(here, "..", "..", "demo-repo"), project, { recursive: true });
// Observe-mode config: every run also executes the project's test suite as evidence.
await mkdir(join(project, ".lattice"));
await writeFile(
  join(project, ".lattice", "config.json"),
  JSON.stringify({ mode: "observe", verify: { command: "npm", args: ["test"], timeoutMs: 60000 } }),
);

let local;
if (!process.env.LATTICE_URL) {
  local = await startLatticeServer({ port: 0, cwd: project });
  console.log(`started in-process daemon at ${local.url}`);
}
const client = new LatticeClient({ baseUrl: local?.url });

try {
  const health = await client.waitUntilReady();
  console.log(`daemon: ${health.service} ${health.version}`);

  // mode "observe" (the daemon default) gathers evidence only: repository
  // snapshot + the configured verifier. "configured" would honour mode:auto.
  const run = await client.runTask("why does the add test fail?", { cwd: project, mode: "observe" });
  console.log(`\nrun ${run.runId} (${run.runtimeMode}): ${run.summary}`);

  const runs = await client.listRuns({ cwd: project, limit: 5 });
  console.log(`\n${runs.length} run(s) recorded:`);
  for (const summary of runs) {
    console.log(`  ${summary.runId.slice(0, 8)}  ${summary.status}  ${summary.task}`);
  }

  const detail = await client.getRun("latest", { cwd: project });
  console.log(`\nTAP evidence for ${detail.runId.slice(0, 8)}:`);
  for (const item of detail.tap?.evidence ?? []) {
    console.log(`  ${item.kind}: ${item.summary.replace(/\s+/g, " ").slice(0, 80)}`);
  }

  const events = await client.getEvents(detail.runId, { cwd: project });
  console.log(`\nevent types: ${events.map((event) => event.type).join(", ")}`);

  // Bounded decision. "random" is an offline baseline; "configured" would
  // call the project's decision model (models.decision ?? model).
  const decision = await client.decide({
    cwd: project,
    provider: "random",
    question: "Which experiment is the cheapest discriminating next step?",
    choices: [
      { id: "run-tests", label: "Run the failing test in isolation" },
      { id: "read-src", label: "Read src/calc.js" },
    ],
  });
  console.log(`\ndecision (${decision.identity.provider}): ${decision.selected.join(", ")}`);

  const doctor = await client.doctor({ cwd: project, network: false });
  console.log(`\ndoctor ok=${doctor.ok}: ${doctor.checks.map((c) => `${c.id}=${c.status}`).join(" ")}`);

  // Errors carry a stable code.
  try {
    await client.getRun("deadbeef", { cwd: project });
  } catch (error) {
    if (!(error instanceof LatticeApiError)) throw error;
    console.log(`\nexpected error: ${error.status} ${error.code} — ${error.message}`);
  }
} finally {
  await local?.close();
}
