import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cassetteDecision,
  cassetteGenerator,
  loadCassette,
  recordCassette,
  replayCassette,
  ReplayDivergenceError,
  createDecisionProvider,
  createRunTaskOptions,
  describeVerify,
  loadLatticeConfig,
  parseLatticeConfig,
} from "./index.js";

test("loadLatticeConfig discovers .lattice/config.json", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lattice-config-"));
  await mkdir(join(cwd, ".lattice"));
  await writeFile(
    join(cwd, ".lattice", "config.json"),
    JSON.stringify({
      mode: "observe",
      verify: { command: "npm", args: ["test"] },
    }),
  );

  const loaded = await loadLatticeConfig(cwd);
  assert.ok(loaded);
  assert.equal(loaded.config.mode, "observe");
  assert.equal(describeVerify(loaded.config.verify!), "npm test");
});

test("auto mode composes model, worker and verifier runtime", () => {
  const config = parseLatticeConfig({
    mode: "auto",
    model: {
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen-test",
    },
    agent: {
      preset: "qwen-code",
      approvalMode: "auto-edit",
    },
    verify: {
      command: "npm",
      args: ["test"],
    },
  });

  const options = createRunTaskOptions(config);
  assert.ok(options.search);
  assert.equal(options.verifyCommand?.command, "npm");
});

test("auto mode refuses to run without objective verification", () => {
  const config = parseLatticeConfig({
    mode: "auto",
    model: {
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen-test",
    },
    agent: {
      preset: "qwen-code",
    },
  });

  assert.throws(
    () => createRunTaskOptions(config),
    /requires configuration for: verify/,
  );
});

test("verify.tessera builds a witness verifier", () => {
  const config = parseLatticeConfig({
    mode: "observe",
    verify: {
      tessera: {
        tsr: "/opt/tsr",
        file: "add.tes",
        overflow: "trapping",
        cases: [{ function: "add", args: [2, 3], expect: "5" }],
      },
    },
  });
  assert.equal(describeVerify(config.verify!), "/opt/tsr witness add.tes (+1 tsr run case)");
  const options = createRunTaskOptions(config);
  assert.equal(options.verifyCommand, undefined);
  assert.equal(options.verifier?.tool, "tessera.witness");

  assert.throws(
    () => parseLatticeConfig({ verify: { tessera: { file: "a.tes", cases: [{ function: "f", args: [], expect: "1" }] } } }),
    /verify.tessera: tessera cases require overflow/,
  );
  assert.throws(
    () => parseLatticeConfig({ verify: { command: "npm", tessera: { file: "a.tes" } } }),
    /either command or tessera/,
  );
});

test("models.decision provider random is a seeded baseline", async () => {
  const config = parseLatticeConfig({
    mode: "observe",
    models: { decision: { provider: "random", seed: 3 } },
  });
  const pick = async () =>
    (await createDecisionProvider(config)!.decide({
      question: "which",
      choices: [{ id: "a", label: "a" }, { id: "b", label: "b" }],
    })).selected;
  assert.deepEqual(await pick(), await pick());
  assert.notDeepEqual(await pick(), ["__none__"]);
  assert.throws(
    () => parseLatticeConfig({ models: { decision: { provider: "random", seed: 1.5 } } }),
    /seed must be an integer/,
  );
});

test("cassette replays recorded calls without touching live providers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lattice-cassette-"));
  const path = join(dir, "run.cassette.jsonl");
  let liveCalls = 0;
  const live = {
    async generate(request: { prompt: string }) {
      liveCalls++;
      return { text: `echo:${request.prompt}`, identity: { provider: "fake" }, usage: { latencyMs: liveCalls } };
    },
  };
  const failing = {
    async decide(): Promise<never> {
      throw new Error("provider down");
    },
  };

  const record = recordCassette(path);
  const generator = cassetteGenerator(record, live as never);
  assert.equal((await generator.generate({ prompt: "one" })).text, "echo:one");
  await assert.rejects(cassetteDecision(record, failing as never).decide({ question: "q", choices: [] }), /provider down/);
  assert.equal((await generator.generate({ prompt: "two" })).text, "echo:two");
  assert.equal(liveCalls, 2);

  const entries = await loadCassette(path);
  assert.deepEqual(entries.map((entry) => entry.kind), ["generator", "decision", "generator"]);

  const never = { async generate(): Promise<never> { throw new Error("live call during replay"); } };
  const neverDecide = { async decide(): Promise<never> { throw new Error("live call during replay"); } };
  const replay = replayCassette(entries);
  const g = cassetteGenerator(replay, never as never);
  const replayed = await g.generate({ prompt: "one" });
  assert.equal(replayed.text, "echo:one");
  assert.equal(replayed.usage.latencyMs, 1);
  // The recorded failure replays as the same failure.
  await assert.rejects(cassetteDecision(replay, neverDecide as never).decide({ question: "q", choices: [] }), /provider down/);
  // A changed request is reported at its call with the field that changed.
  await assert.rejects(g.generate({ prompt: "TWO" }), (error: unknown) => {
    assert.ok(error instanceof ReplayDivergenceError);
    assert.equal(error.seq, 3);
    assert.equal(error.reason, "request");
    assert.deepEqual(error.changedFields, ["prompt"]);
    return true;
  });

  // Fewer calls than recorded is a divergence too.
  const short = replayCassette(entries);
  await cassetteGenerator(short, never as never).generate({ prompt: "one" });
  assert.throws(() => short.assertConsumed(), /call 2/);
  // More calls than recorded fails loudly.
  const long = replayCassette(entries.slice(0, 1));
  await cassetteGenerator(long, never as never).generate({ prompt: "one" });
  await assert.rejects(cassetteGenerator(long, never as never).generate({ prompt: "x" }), /no recorded generator call/);
});
