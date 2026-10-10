import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRunTaskOptions,
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
  assert.equal(loaded.config.verify?.command, "npm");
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

test("retry and budget settings survive config parsing and reach the search options", () => {
  const config = parseLatticeConfig({
    mode: "auto",
    model: {
      provider: "systemone",
      baseUrl: "http://127.0.0.1:8080",
      model: "tev1:0.8b",
      retry: { attempts: 4, baseDelayMs: 100, maxDelayMs: 2000 },
    },
    agent: { preset: "qwen-code" },
    verify: { command: "npm", args: ["test"] },
    search: {
      maxRounds: 3,
      budget: { maxTokens: 50_000, maxCostUsd: 0.5, maxWallMs: 120_000 },
    },
  });

  assert.deepEqual(config.model?.retry, { attempts: 4, baseDelayMs: 100, maxDelayMs: 2000 });
  const options = createRunTaskOptions(config);
  assert.equal(options.search?.maxRounds, 3);
  assert.deepEqual(options.search?.budget, {
    maxTokens: 50_000,
    maxCostUsd: 0.5,
    maxWallMs: 120_000,
  });
});
