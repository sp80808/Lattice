#!/usr/bin/env node
// Embed Lattice's evidence-driven search loop with your own providers.
//
// No model or network needed: the generator and decision provider below are
// deterministic stand-ins for an LLM, and the executor runs *real* commands so
// the outcome is decided by objective test evidence, not by the "model".
//
//   npm run build && node examples/embedded/offline-search-loop.mjs
//
// Swap ScriptedGenerator/CheapestFirstDecider for OpenAICompatible*Provider
// from @lattice/providers to run the same loop against a real model.
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTask } from "@lattice/core";
import { runCommand } from "@lattice/execution";

const here = dirname(fileURLToPath(import.meta.url));

// 1. A throwaway copy of the broken demo project (add() subtracts).
const repo = await mkdtemp(join(tmpdir(), "lattice-offline-"));
await cp(join(here, "..", "demo-repo"), repo, { recursive: true });

// 2. Generator: proposes candidate actions as the JSON shape the loop expects.
//    Round 1 offers cheap evidence-gathering; later rounds offer an edit.
class ScriptedGenerator {
  round = 0;
  async generate() {
    this.round++;
    const candidates =
      this.round === 1
        ? [
            { id: "reproduce", label: "Run the test suite", action: "npm test", expectedEvidence: "which assertions fail", estimatedCost: "low" },
            { id: "rewrite", label: "Rewrite the calculator module", action: "replace src/calc.js", expectedEvidence: "tests after a rewrite", estimatedCost: "high" },
          ]
        : [
            { id: "fix-add", label: "Change add to use +", action: "edit src/calc.js add()", expectedEvidence: "npm test passes", estimatedCost: "medium" },
            { id: "rewrite", label: "Rewrite the calculator module", action: "replace src/calc.js", expectedEvidence: "tests after a rewrite", estimatedCost: "high" },
          ];
    return {
      text: JSON.stringify({ candidates }),
      identity: { provider: "scripted", model: "offline-demo" },
      usage: { latencyMs: 0 },
    };
  }
}

// 3. Decision provider: a cheap, bounded chooser. Here: prefer the cheapest
//    option. The loop validates that the chosen ID was actually offered.
const COST = { low: 0.6, medium: 0.3, high: 0.1 };
class CheapestFirstDecider {
  constructor(costs) {
    this.costs = costs;
  }
  async decide(request) {
    const scores = Object.fromEntries(request.choices.map((c) => [c.id, COST[this.costs.get(c.id)] ?? 0.05]));
    const total = Object.values(scores).reduce((a, b) => a + b, 0);
    for (const id of Object.keys(scores)) scores[id] /= total;
    const [best] = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    return {
      selected: [best[0]],
      scores,
      confidence: best[1],
      identity: { provider: "cheapest-first" },
      usage: { latencyMs: 0 },
    };
  }
}

// 4. Executor: performs the chosen action and reports *objective* evidence.
const npmTest = () => runCommand({ command: "npm", args: ["test"], cwd: repo, timeoutMs: 60_000 });
const testEvidence = (result) => ({
  id: `ev:test-${Date.now()}`,
  kind: "test",
  verified: true, // produced by running the suite, not claimed by a model
  source: "npm test",
  summary: `exit=${result.exitCode}`,
  createdAt: new Date().toISOString(),
});

const executor = {
  async execute(candidate) {
    if (candidate.id === "fix-add") {
      const file = join(repo, "src", "calc.js");
      await writeFile(file, (await readFile(file, "utf8")).replace("return a - b;", "return a + b;"));
    }
    const result = await npmTest();
    const passed = result.exitCode === 0;
    return {
      candidateId: candidate.id,
      status: passed ? "success" : "failure",
      terminal: passed && candidate.id !== "reproduce",
      summary: passed ? "test suite passes" : "test suite fails: add returns the wrong value",
      evidence: [testEvidence(result)],
    };
  },
};

const generator = new ScriptedGenerator();
const costs = new Map([["reproduce", "low"], ["fix-add", "medium"], ["rewrite", "high"]]);

const result = await runTask("fix the failing add test", {
  cwd: repo,
  search: {
    generator,
    decision: new CheapestFirstDecider(costs),
    executor,
    maxRounds: 3,
    candidatesPerRound: 2,
  },
});

console.log(result.summary);
console.log("");
console.log("evidence:");
for (const item of result.tap.evidence) {
  console.log(`  ${item.verified ? "✓" : "?"} ${item.kind.padEnd(10)} ${item.summary.slice(0, 90)}`);
}
console.log("");
console.log("history:", result.tap.context.filter((line) => /^r\d+:/.test(line)).join(" → "));
console.log(`replay log: ${result.eventLogPath}`);
console.log(`inspect it: node apps/cli/dist/index.js -C ${repo} show latest --events`);

if (!/search solved/.test(result.summary)) {
  console.error("expected the search to be solved by objective evidence");
  process.exitCode = 1;
}
