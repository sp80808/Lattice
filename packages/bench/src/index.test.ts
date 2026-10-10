import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  compareBenchReports,
  loadSuite,
  passAtK,
  resolveTools,
  runBenchmark,
  seededRandom,
  selectShard,
  selfCheckSuite,
  wilson95,
  type BenchReport,
  type StrategyName,
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..", "..");
const BASIC = join(ROOT, "benchmarks", "basic");
const TESSERA = join(ROOT, "benchmarks", "tessera");

/** Everything except wall-clock time, which legitimately varies between runs. */
const stable = (report: BenchReport) =>
  report.results.map(({ wallMs: _wallMs, ...rest }) => rest);

test("seededRandom is reproducible and uniform even for consecutive small seeds", () => {
  assert.equal(seededRandom(7)(), seededRandom(7)());
  assert.notEqual(seededRandom(7)(), seededRandom(8)());

  // Raw mulberry32 is visibly lumpy on seeds 1..40; hashing the seed fixes that.
  const buckets = [0, 0, 0, 0];
  for (let seed = 1; seed <= 400; seed++) buckets[Math.floor(seededRandom(seed)() * 4)]!++;
  const chi2 = buckets.reduce((sum, count) => sum + (count - 100) ** 2 / 100, 0);
  assert.ok(chi2 < 11.3, `first draws not uniform: ${buckets} (chi2=${chi2.toFixed(1)}, limit 11.3 at p=0.01)`);
});

test("wilson95 is sane at the edges and narrows with more data", () => {
  assert.deepEqual(wilson95(0, 0), [0, 1]);
  const [lo3, hi3] = wilson95(3, 3);
  assert.ok(hi3 === 1 && lo3 > 0.4 && lo3 < 0.5, `3/3 should be roughly 44-100%, got ${lo3}-${hi3}`);
  const [lo, hi] = wilson95(60, 120);
  assert.ok(lo < 0.5 && hi > 0.5 && hi - lo < 0.2);
});

test("suite loading validates specs and fingerprints fixtures", async () => {
  const suite = await loadSuite(BASIC);
  assert.deepEqual(suite.tasks.map((task) => task.id), [
    "calc-add-sign",
    "clamp-bounds",
    "greet-export",
    "py-fib-base",
    "ts-narrow-type",
  ]);
  assert.match(suite.digest, /^[0-9a-f]{64}$/);
  assert.equal((await loadSuite(BASIC)).digest, suite.digest, "digest is stable");

  const bad = await mkdtemp(join(tmpdir(), "lattice-bench-bad-"));
  await mkdir(join(bad, "t", "repo"), { recursive: true });
  const spec = (candidates: unknown[]) =>
    writeFile(
      join(bad, "t", "task.json"),
      JSON.stringify({ id: "t", task: "x", verify: { command: "true" }, candidates }),
    );
  const c = (id: string, extra = {}) => ({ id, label: id, action: id, expectedEvidence: id, ...extra });

  await spec([c("a"), c("b")]);
  await assert.rejects(loadSuite(bad), /exactly one candidate must set solves/);
  await spec([c("a", { solves: true }), c("b")]);
  await assert.rejects(loadSuite(bad), /solves requires a patch/);
  await spec([c("a"), c("a")]);
  await assert.rejects(loadSuite(bad), /duplicate candidate id/);
  await spec([c("__none__"), c("b")]);
  await assert.rejects(loadSuite(bad), /invalid or duplicate candidate id/);
  await assert.rejects(loadSuite(join(bad, "missing")), /suite directory not found/);
});

test("every basic fixture fails as shipped and passes with its solution", async () => {
  const rows = await selfCheckSuite(await loadSuite(BASIC), {});
  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.equal(row.baselineFails, true, `${row.task} should fail as shipped`);
    assert.equal(row.solutionPasses, true, `${row.task} should pass with its solution`);
  }
});

test("the oracle solves in one experiment; other strategies cost more and invalid edits are counted", async () => {
  const suite = await loadSuite(BASIC);
  const report = await runBenchmark(suite, { trials: 12, seed: 1, maxRounds: 4, tools: {} });

  const by = Object.fromEntries(report.summary.map((row) => [row.strategy, row]));
  assert.equal(by.oracle!.solveRate, 1);
  assert.equal(by.oracle!.meanExperiments, 1);
  assert.equal(by.oracle!.invalidEdits, 0);

  // With a full 4-round budget every strategy eventually finds the fix, but not as cheaply.
  for (const name of ["first", "random", "cheapest-first"] as const) {
    assert.equal(by[name]!.solveRate, 1, `${name} should solve given 4 rounds`);
    assert.ok(by[name]!.meanExperiments > by.oracle!.meanExperiments, `${name} should cost more than the oracle`);
  }
  // `first` walks the list in order, so it hits the hallucinated-target decoys.
  assert.ok(by.first!.invalidEdits + by.random!.invalidEdits + by["cheapest-first"]!.invalidEdits > 0);

  // Deterministic strategies run once per task; only `random` repeats.
  assert.equal(by.first!.runs, 5);
  assert.equal(by.oracle!.runs, 5);
  assert.equal(by.random!.runs, 60);
  assert.deepEqual(by.oracle!.solveRateCI95, wilson95(5, 5));
});

test("a tight budget separates strategies: oracle beats random beats nothing", async () => {
  const suite = await loadSuite(BASIC);
  const report = await runBenchmark(suite, { strategies: ["random", "oracle"], trials: 40, seed: 1, maxRounds: 2, tools: {} });
  const random = report.summary.find((row) => row.strategy === "random")!;
  const oracle = report.summary.find((row) => row.strategy === "oracle")!;
  assert.equal(oracle.solveRate, 1);
  // Ideal is 50% (2 of 4 candidates tried); a wide band keeps this test from flaking on the seed.
  assert.ok(random.solveRate > 0.3 && random.solveRate < 0.7, `random solve rate ${random.solveRate}`);
  assert.ok(random.solveRateCI95[1] < 1 && random.solveRateCI95[0] > 0.2);
});

test("results are reproducible for a fixed seed and the report records its provenance", async () => {
  const suite = await loadSuite(BASIC);
  const options = { strategies: ["random", "first"] as const, trials: 6, seed: 42, tools: {} };
  const a = await runBenchmark(suite, { ...options, strategies: [...options.strategies] });
  const b = await runBenchmark(suite, { ...options, strategies: [...options.strategies] });
  assert.deepEqual(stable(a), stable(b));

  const other = await runBenchmark(suite, { ...options, strategies: ["random"], seed: 43 });
  assert.notDeepEqual(
    stable(a).filter((row) => row.strategy === "random").map((row) => row.executed),
    stable(other).map((row) => row.executed),
    "a different seed should change random's choices",
  );

  assert.equal(a.schemaVersion, 1);
  assert.equal(a.suite.digest, suite.digest);
  assert.deepEqual(a.config, {
    strategies: ["random", "first"],
    trials: 6,
    seed: 42,
    maxRounds: 2,
    concurrency: 1,
    passAtK: [1, 5],
    configured: undefined,
  });
  assert.equal(a.environment.node, process.version);
  assert.equal(a.environment.concurrency, 1);
  assert.match(a.note, /orchestration logic, not model quality/);
});

test("`configured` needs a provider, and unknown task filters are rejected", async () => {
  const suite = await loadSuite(BASIC);
  await assert.rejects(runBenchmark(suite, { strategies: ["configured"], tools: {} }), /needs a decision provider/);
  await assert.rejects(runBenchmark(suite, { only: ["nope"], tools: {} }), /unknown task/);
  await assert.rejects(runBenchmark(suite, { trials: 0, tools: {} }), /trials must be a positive integer/);

  // A real decision provider plugs in through the same interface.
  const report = await runBenchmark(suite, {
    strategies: ["configured"],
    trials: 2,
    maxRounds: 1,
    only: ["calc-add-sign"],
    tools: {},
    configuredDescription: "stub",
    configured: {
      async decide(request) {
        const id = request.choices.find((choice) => choice.id === "fix-add")!.id;
        return { selected: [id], scores: { [id]: 1 }, identity: { provider: "stub" }, usage: { latencyMs: 0 } };
      },
    },
  });
  assert.equal(report.summary[0]!.solveRate, 1);
  assert.equal(report.config.configured, "stub");
  assert.equal(report.summary[0]!.runs, 2, "a nondeterministic provider gets repeated trials");
});

test("tasks that need tsr are skipped, not failed, when it is unavailable", async () => {
  const suite = await loadSuite(TESSERA);
  const report = await runBenchmark(suite, { strategies: ["oracle"], tools: {} });
  assert.equal(report.suite.tasks.length, 0);
  assert.equal(report.skipped.length, 3);
  assert.match(report.skipped[0]!.reason, /missing tool: tsr/);

  const rows = await selfCheckSuite(suite, {});
  assert.ok(rows.every((row) => row.skipped?.includes("tsr")));
});

test("passAtK is the unbiased probability that one of k sampled trials succeeds", () => {
  assert.ok(Number.isNaN(passAtK(2, 1, 5)), "fewer trials than k is unknowable");
  assert.equal(passAtK(4, 0, 1), 0);
  assert.equal(passAtK(4, 4, 1), 1);
  assert.equal(passAtK(4, 3, 4), 1, "if only one trial failed, some 4-subset must contain a success");
  // Known value: n=4, c=2, k=2 -> 1 - C(2,2)/C(4,2) = 1 - 1/6.
  assert.ok(Math.abs(passAtK(4, 2, 2) - 5 / 6) < 1e-12);
  // Monotone in k and in c.
  assert.ok(passAtK(10, 3, 2) < passAtK(10, 3, 5));
  assert.ok(passAtK(10, 2, 5) < passAtK(10, 5, 5));
});

test("task metadata is validated and surfaces per difficulty", async () => {
  const bad = await mkdtemp(join(tmpdir(), "lattice-bench-meta-"));
  await mkdir(join(bad, "t", "repo"), { recursive: true });
  const spec = (metadata: unknown) =>
    writeFile(
      join(bad, "t", "task.json"),
      JSON.stringify({
        id: "t",
        task: "x",
        verify: { command: "true" },
        candidates: [
          { id: "a", label: "a", action: "a", expectedEvidence: "a" },
          { id: "b", label: "b", action: "b", expectedEvidence: "b", solves: true, patch: { file: "f", find: "x", replace: "y" } },
        ],
        metadata,
      }),
    );

  await spec({ difficulty: "easy" });
  const suite = await loadSuite(bad);
  assert.equal(suite.tasks[0]!.metadata?.difficulty, "easy");

  await spec({ difficulty: "trivial" });
  await assert.rejects(loadSuite(bad), /metadata.difficulty must be/);
  await spec({ category: "" });
  await assert.rejects(loadSuite(bad), /metadata.category must be a non-empty string/);

  const annotated = await loadSuite(BASIC);
  assert.deepEqual(annotated.tasks.map((task) => task.metadata?.difficulty), ["easy", "easy", "medium", "easy", "easy"]);
  const report = await runBenchmark(annotated, { strategies: ["oracle"], tools: {} });
  assert.deepEqual(
    report.byDifficulty.map((row) => [row.difficulty, row.solved, row.runs]),
    [
      ["easy", 4, 4],
      ["medium", 1, 1],
    ],
  );
});

test("the report breaks down per task and classifies failures", async () => {
  const suite = await loadSuite(BASIC);
  const report = await runBenchmark(suite, { strategies: ["first", "oracle"], maxRounds: 2, tools: {} });

  // One row per task × strategy, in task-then-strategy order.
  assert.deepEqual(report.byTask.map((row) => [row.task, row.strategy]), [
    ["calc-add-sign", "first"],
    ["calc-add-sign", "oracle"],
    ["clamp-bounds", "first"],
    ["clamp-bounds", "oracle"],
    ["greet-export", "first"],
    ["greet-export", "oracle"],
    ["py-fib-base", "first"],
    ["py-fib-base", "oracle"],
    ["ts-narrow-type", "first"],
    ["ts-narrow-type", "oracle"],
  ]);

  const oracle = report.summary.find((row) => row.strategy === "oracle")!;
  assert.equal(oracle.solveRate, 1);
  assert.deepEqual(oracle.failures, []);
  assert.equal(oracle.meanTokens, 0, "scripted strategies bill no tokens");
  assert.equal(oracle.costPerSolved, null);

  // `first` burns its 2-round budget on decoys: the failing runs are ordinary
  // verifier failures, not spend on a missing binary.
  const first = report.summary.find((row) => row.strategy === "first")!;
  assert.ok(first.solveRate < 1);
  const kinds = Object.fromEntries(first.failures.map((row) => [row.kind, row.count]));
  assert.ok(kinds["verifier-failed"] > 0, `expected verifier failures, got ${JSON.stringify(first.failures)}`);
  assert.ok(kinds["invalid-edit"] === undefined, "2 rounds never reach the hallucinated-target decoys");
});

/** A suite whose verifier binary does not exist: command failures, not a crash. */
async function missingBinarySuite(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lattice-bench-nobin-"));
  await mkdir(join(dir, "nf", "repo"), { recursive: true });
  await writeFile(join(dir, "nf", "repo", "f.txt"), "x");
  await writeFile(
    join(dir, "nf", "task.json"),
    JSON.stringify({
      id: "nf",
      task: "x",
      verify: { command: "lattice-no-such-verifier-binary" },
      candidates: [
        { id: "inspect", label: "inspect", action: "look", expectedEvidence: "nothing" },
        {
          id: "fix",
          label: "fix",
          action: "edit",
          expectedEvidence: "verifier passes",
          solves: true,
          patch: { file: "f.txt", find: "x", replace: "y" },
        },
      ],
    }),
  );
  return dir;
}

test("a missing verifier binary is classified as command-not-found instead of crashing", async () => {
  const suite = await loadSuite(await missingBinarySuite());
  const report = await runBenchmark(suite, { strategies: ["oracle"], tools: {} });

  assert.equal(report.summary[0]!.runs, 1);
  assert.equal(report.summary[0]!.solved, 0);
  assert.deepEqual(report.summary[0]!.failures, [{ kind: "command-not-found", count: 1 }]);
  assert.equal(report.results[0]!.failureKind, "command-not-found");
});

test("a hallucinated edit target is classified as invalid-edit", async () => {
  const suite = await loadSuite(BASIC);
  // A stub decision provider that always picks the candidate whose patch targets a
  // nonexistent file: the executor must fail the attempt, not throw.
  const report = await runBenchmark(suite, {
    strategies: ["configured"],
    trials: 1,
    maxRounds: 1,
    only: ["calc-add-sign"],
    tools: {},
    configuredDescription: "stub",
    configured: {
      async decide(request) {
        const id = request.choices.find((choice) => choice.id === "patch-utils")!.id;
        return { selected: [id], scores: { [id]: 1 }, identity: { provider: "stub" }, usage: { latencyMs: 0 } };
      },
    },
  });

  assert.equal(report.results[0]!.invalidEdits, 1);
  assert.equal(report.results[0]!.failureKind, "invalid-edit");
  assert.deepEqual(report.summary[0]!.failures, [{ kind: "invalid-edit", count: 1 }]);
});

test("compareBenchReports gates regressions and tolerates noise", () => {
  const report = (solved: number, runs: number, digest = "d1"): BenchReport =>
    ({
      schemaVersion: 1,
      suite: { name: "s", digest, tasks: ["t"] },
      summary: [{ strategy: "oracle", runs, solved, solveRate: solved / runs }],
    }) as unknown as BenchReport;

  const base = report(10, 10);
  const same = compareBenchReports(base, report(10, 10));
  assert.deepEqual(same.regressions, []);
  assert.deepEqual(same.improvements, []);
  assert.equal(same.suiteChanged, false);

  const worse = compareBenchReports(base, report(7, 10));
  assert.equal(worse.regressions.length, 1);
  assert.ok(Math.abs(worse.regressions[0]!.delta + 0.3) < 1e-12);
  // A drop within tolerance is not a regression.
  assert.deepEqual(compareBenchReports(base, report(9, 10), 0.2).regressions, []);

  const better = compareBenchReports(base, report(10, 10));
  assert.deepEqual(better.regressions, []);
  const gain = compareBenchReports(report(5, 10), report(9, 10));
  assert.equal(gain.improvements.length, 1);

  // A strategy missing from the candidate regressed to zero rather than silently passing.
  const missing = compareBenchReports(base, { ...report(10, 10), summary: [] } as BenchReport);
  assert.equal(missing.regressions[0]!.candidateRuns, 0);
  assert.equal(missing.regressions[0]!.candidateSolveRate, 0);

  assert.equal(compareBenchReports(base, report(10, 10, "other")).suiteChanged, true);
});

test("selectShard partitions deterministically and rejects bad input", () => {
  const items = ["a", "b", "c", "d", "e"];
  assert.deepEqual(selectShard(items, "1/2"), ["a", "c", "e"]);
  assert.deepEqual(selectShard(items, "2/2"), ["b", "d"]);
  assert.deepEqual(selectShard(items, "3/3"), ["c"]);
  assert.deepEqual([...selectShard(items, "1/2"), ...selectShard(items, "2/2")].sort(), items);
  assert.throws(() => selectShard(items, "0/2"), /1 <= i <= n/);
  assert.throws(() => selectShard(items, "3/2"), /1 <= i <= n/);
  assert.throws(() => selectShard(items, "half"), /i\/n/);
});

test("parallel trials are faster than sequential and give identical results", async (t) => {
  const suite = await loadSuite(BASIC);
  const options = { strategies: ["random"] as StrategyName[], trials: 12, seed: 1, maxRounds: 2, tools: {} };

  const serial = await runBenchmark(suite, { ...options, concurrency: 1 });
  const parallel = await runBenchmark(suite, { ...options, concurrency: 4 });

  assert.equal(parallel.environment.concurrency, 4);
  assert.equal(parallel.config.concurrency, 4);
  assert.deepEqual(
    parallel.results.map(({ wallMs: _w, ...rest }) => rest),
    serial.results.map(({ wallMs: _w, ...rest }) => rest),
    "concurrency must not change what is measured",
  );

  await assert.rejects(runBenchmark(suite, { ...options, concurrency: 0 }), /concurrency must be a positive integer/);
  t.diagnostic(`serial wall ${serial.summary[0]!.meanWallMs.toFixed(0)}ms vs parallel ${parallel.summary[0]!.meanWallMs.toFixed(0)}ms per trial`);
});

test("live: the real Tessera compiler verifies the tessera suite", async (t) => {
  const tools = await resolveTools(ROOT);
  if (!tools.tsr) {
    t.skip("tsr not found (build ../Tessera with `cargo build -p tessera-cli` or set TSR_BIN)");
    return;
  }
  const suite = await loadSuite(TESSERA);

  // The compiler, not the fixture author, decides: each task must fail then pass under real `tsr run`.
  for (const row of await selfCheckSuite(suite, tools)) {
    assert.equal(row.baselineFails, true, `${row.task} should fail as shipped under tsr`);
    assert.equal(row.solutionPasses, true, `${row.task} should pass with its solution under tsr`);
  }

  const report = await runBenchmark(suite, { strategies: ["oracle", "random"], trials: 20, seed: 1, tools });
  assert.equal(report.environment.tsr, tools.tsr);
  assert.equal(report.suite.tasks.length, 3);
  const oracle = report.summary.find((row) => row.strategy === "oracle")!;
  const random = report.summary.find((row) => row.strategy === "random")!;
  assert.equal(oracle.solveRate, 1);
  assert.equal(oracle.meanExperiments, 1);
  assert.ok(random.solveRate < 1, "random cannot always solve within a 2-round budget");
});
