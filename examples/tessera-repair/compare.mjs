#!/usr/bin/env node
// MVP slice: Lattice repairs deliberately broken Tessera programs, the real
// `tsr` binary alone decides success, and each run's rounds, tsr verifications,
// tokens and cost are compared with a random-choice baseline on the same tasks
// and seeds.
//
//   npm run build
//   TSR=/path/to/tsr node examples/tessera-repair/compare.mjs            # offline stubs
//   TSR=... node examples/tessera-repair/compare.mjs --generator model --decider model \
//     --base-url http://127.0.0.1:11434/v1 --model qwen3-coder          # a real model
//
// Every run's log (with each witness document) lands in .lattice/runs of a
// temporary copy of the task; `--keep` prints where. Nothing here is mocked on
// the verification path: without a working tsr every candidate is a tool error.
import { readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  OpenAICompatibleDecisionProvider,
  OpenAICompatibleGeneratorProvider,
} from "@lattice/providers";
import {
  HeuristicRepairDecider,
  compareRepair,
  formatComparison,
  loadRepairTask,
  randomArm,
  runWitness,
} from "@lattice/tessera";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    tsr: { type: "string" },
    tasks: { type: "string" },
    seeds: { type: "string", default: "5" },
    "max-rounds": { type: "string", default: "6" },
    candidates: { type: "string", default: "4" },
    generator: { type: "string", default: "stub" },
    decider: { type: "string", default: "heuristic" },
    "base-url": { type: "string", default: process.env.LATTICE_BASE_URL },
    model: { type: "string", default: process.env.LATTICE_MODEL },
    "decision-model": { type: "string" },
    "api-key-env": { type: "string", default: process.env.LATTICE_API_KEY_ENV },
    "price-in": { type: "string" },
    "price-out": { type: "string" },
    out: { type: "string" },
    json: { type: "boolean" },
  },
});

const fail = (message) => {
  console.error(`compare: ${message}`);
  process.exit(2);
};
if (values.tsr) process.env.TSR = values.tsr;

// Refuse to start without a working compiler rather than report tool errors as results.
const probe = await runWitness(join(here, "tasks", "syntax-error", "add.tes"));
if (probe.verdict.outcome !== "fail") {
  fail(`tsr witness is not usable (${probe.verdict.reason ?? probe.verdict.outcome}); set TSR or --tsr to a Tessera build`);
}

const needsModel = values.generator === "model" || values.decider === "model";
let endpoint;
if (needsModel) {
  if (!values["base-url"] || !values.model) fail("--base-url and --model are required for a model arm");
  const apiKey = values["api-key-env"] ? process.env[values["api-key-env"]] : undefined;
  if (values["api-key-env"] && !apiKey) fail(`${values["api-key-env"]} is not set`);
  endpoint = { baseUrl: values["base-url"], apiKey, timeoutMs: 120_000, providerName: "openai-compatible" };
}
const generator =
  values.generator === "model"
    ? () => new OpenAICompatibleGeneratorProvider({ ...endpoint, model: values.model })
    : values.generator === "stub"
      ? undefined
      : fail("--generator must be stub or model");
const configured =
  values.decider === "model"
    ? { name: `model:${values["decision-model"] ?? values.model}`, decision: () => new OpenAICompatibleDecisionProvider({ ...endpoint, model: values["decision-model"] ?? values.model }), generator }
    : values.decider === "heuristic"
      ? { name: "heuristic", decision: (_seed, original) => new HeuristicRepairDecider(original), generator }
      : fail("--decider must be heuristic or model");

const pricing =
  values["price-in"] || values["price-out"]
    ? { inputPerMTok: Number(values["price-in"] ?? 0), outputPerMTok: Number(values["price-out"] ?? 0) }
    : undefined;

const names = values.tasks?.split(",") ?? (await readdir(join(here, "tasks"))).sort();
const tasks = await Promise.all(names.map((name) => loadRepairTask(join(here, "tasks", name))));
const seedCount = Number(values.seeds);
if (!Number.isInteger(seedCount) || seedCount < 1) fail("--seeds must be a positive integer");

const report = await compareRepair({
  tasks,
  arms: [configured, randomArm(generator)],
  seeds: Array.from({ length: seedCount }, (_, i) => i + 1),
  maxRounds: Number(values["max-rounds"]),
  candidatesPerRound: Number(values.candidates),
  pricing,
  onRun: (run) =>
    console.error(
      `  ${run.task.padEnd(14)} ${run.arm.padEnd(12)} seed=${run.seed} ${run.status} rounds=${run.rounds} tokens=${run.tokens}${run.error ? ` error=${run.error}` : ""}`,
    ),
});

if (values.out) await writeFile(values.out, JSON.stringify(report, null, 2) + "\n");
if (values.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`tsr ${report.tsr?.version}@${report.tsr?.commit?.slice(0, 12)}${report.tsr?.dirty ? "+dirty" : ""}, seeds 1..${seedCount}, ${report.maxRounds} rounds of ${report.candidatesPerRound} candidates`);
  console.log(formatComparison(report));
  const example = report.runs.find((run) => run.status === "solved");
  if (example) console.log(`\nexample run log (replay with replayRunLog): ${example.eventLogPath}`);
}

const solved = report.runs.filter((run) => run.status === "solved").length;
if (solved === 0) {
  console.error("compare: no run produced a verified patch");
  process.exitCode = 1;
}
