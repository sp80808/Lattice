import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDecisionProvider,
  createRunTaskOptions,
  describeVerify,
  effectivePermissions,
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

test("intents narrow the config and never widen it", () => {
  const auto = parseLatticeConfig({
    mode: "auto",
    model: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen-test" },
    agent: { preset: "qwen-code" },
    verify: { command: "npm", args: ["test"] },
  });
  const observe = parseLatticeConfig({ mode: "observe", verify: { command: "npm" } });

  for (const intent of ["plan", "review"] as const) {
    const options = createRunTaskOptions(auto, { intent });
    assert.equal(options.search, undefined);
    assert.equal(options.verifyCommand, undefined);
    assert.equal(options.verifier, undefined);
    assert.equal(options.intent, intent);
  }

  const debug = createRunTaskOptions(auto, { intent: "debug" });
  assert.equal(debug.search, undefined);
  assert.equal(debug.verifyCommand?.command, "npm");

  assert.ok(createRunTaskOptions(auto, { intent: "act" }).search);
  assert.ok(createRunTaskOptions(auto).search);

  // act cannot elevate an observe config.
  const act = createRunTaskOptions(observe, { intent: "act" });
  assert.equal(act.search, undefined);
  assert.deepEqual(effectivePermissions(observe, "act"), {
    read: "allow",
    verify: "allow",
    search: "deny",
    agent: "deny",
  });
  assert.throws(() => effectivePermissions(auto, "yolo" as never), /unknown intent/);
});
