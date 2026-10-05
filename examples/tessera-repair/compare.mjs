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
  claudeCodeFetch,
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
    "max-tokens": { type: "string", default: "4096" },
    "claude-code": { type: "boolean" },
    out: { type: "string" },
    json: { type: "boolean" },
    // Measure the generator alone: skip tsr witness's own checked suggestions.
    "no-suggestions": { type: "boolean" },
    // Run with and without tsr suggestions and report both.
    ablation: { type: "boolean" },
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
  if (values["claude-code"]) {
    // Run on the local Claude Code CLI (your plan, no API key); --model picks the CLI model.
    values["base-url"] ??= "claude-code://local";
    values.model ??= "claude-code-default";
  }
  if (!values["base-url"] || !values.model) fail("--base-url and --model are required for a model arm");
  const apiKey = values["api-key-env"] ? process.env[values["api-key-env"]] : undefined;
  if (values["api-key-env"] && !apiKey) fail(`${values["api-key-env"]} is not set`);
  const maxTokens = Number(values["max-tokens"]);
  if (!Number.isInteger(maxTokens) || maxTokens < 1) fail("--max-tokens must be a positive integer");
  endpoint = {
    baseUrl: values["base-url"],
    apiKey,
    maxTokens,
    timeoutMs: 180_000,
    providerName: values["claude-code"] ? "claude-code" : "openai-compatible",
    ...(values["claude-code"]
      ? { fetchImpl: claudeCodeFetch({ model: values.model === "claude-code-default" ? undefined : values.model }) }
      : {}),
  };
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

const run = (suggestions) =>
  compareRepair({
    tasks,
    arms: [configured, randomArm(generator)],
    seeds: Array.from({ length: seedCount }, (_, i) => i + 1),
    maxRounds: Number(values["max-rounds"]),
    candidatesPerRound: Number(values.candidates),
    pricing,
    suggestions,
    onRun: (run) => {
      console.error(
        `  ${run.task.padEnd(14)} ${run.arm.padEnd(12)} seed=${run.seed} ${run.status} rounds=${run.rounds} tokens=${run.tokens}${run.lineage ? ` by=${run.lineage.candidateSource}` : ""}${run.error ? ` error=${run.error}` : ""}`,
      );
      // Auth, billing and rate-limit errors fail every later run the same way.
      const status = /Provider request failed: (\d{3})/.exec(run.error ?? "")?.[1];
      if (status && ["401", "402", "403", "429"].includes(status)) {
        fail(`provider refused the request (HTTP ${status}); stopping instead of running the rest into the same error`);
      }
    },
  }).catch((error) => fail(error instanceof Error ? error.message : String(error)));

// --ablation runs both configurations so the generator-only result is reported, not inferred.
const reports = values.ablation
  ? [await run(true), await run(false)]
  : [await run(!values["no-suggestions"])];
const output = reports.length === 1 ? reports[0] : { withSuggestions: reports[0], withoutSuggestions: reports[1] };

if (values.out) await writeFile(values.out, JSON.stringify(output, null, 2) + "\n");
if (values.json) console.log(JSON.stringify(output, null, 2));
else {
  for (const report of reports) {
    console.log(`tsr ${report.tsr?.version}@${report.tsr?.commit?.slice(0, 12)}${report.tsr?.dirty ? "+dirty" : ""}, seeds 1..${seedCount}, ${report.maxRounds} rounds of ${report.candidatesPerRound} candidates`);
    console.log(formatComparison(report));
    console.log("");
  }
  const example = reports[0].runs.find((run) => run.status === "solved");
  if (example) console.log(`example run log (replay with replayRunLog): ${example.eventLogPath}`);
}

const solved = reports.flatMap((report) => report.runs).filter((run) => run.status === "solved").length;
if (solved === 0) {
  console.error("compare: no run produced a verified patch");
  process.exitCode = 1;
}
