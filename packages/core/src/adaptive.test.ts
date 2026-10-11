import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runAdaptiveWorkflow,
  WEB_PWA_UX_RECIPE,
  SYSTEMATIC_DEBUGGING_RECIPE,
} from "./adaptive.js";

async function createTempRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lattice-adaptive-"));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, contents, "utf8");
  }
  return dir;
}

test("runAdaptiveWorkflow classifies UI task, matches React/Web recipe, and generates contract", async () => {
  const dir = await createTempRepo({
    "package.json": JSON.stringify({
      name: "mobile-shop",
      dependencies: { react: "^18.3.1" },
      devDependencies: { vite: "^5.0.0" },
      scripts: { test: "node --version" }, // valid passing command for test
    }),
    "src/Shop.tsx": "export const Shop = () => <button>Equip</button>;\n",
  });

  try {
    const result = await runAdaptiveWorkflow({
      task: "Improve this mobile game equipment shop, fix overlapping buttons and preserve all existing functionality",
      cwd: dir,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.taskClassification.class, "ui");
    assert.ok(result.fingerprint.stacks.includes("react"));
    assert.ok(result.fingerprint.stacks.includes("vite"));
    assert.equal(result.fingerprint.appType, "web-app");

    // Selected capabilities must include the Web/UX recipe
    assert.ok(result.capabilities.selected.some((c) => c.id === WEB_PWA_UX_RECIPE.id));
    assert.equal(result.contract.commands.length, 1);
    assert.ok(result.contract.commands[0].includes("node --version"));
    assert.equal(result.fidelityReport.ok, true);
    assert.ok(result.evidence.some((e) => e.verified === true));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runAdaptiveWorkflow pauses for clarification on destructive actions", async () => {
  const dir = await createTempRepo({
    "package.json": JSON.stringify({ name: "safe-project" }),
  });

  try {
    const result = await runAdaptiveWorkflow({
      task: "Purge and delete all user records and drop table",
      cwd: dir,
      autonomy: "supervised",
    });

    assert.equal(result.status, "needs_clarification");
    assert.ok(result.clarificationPrompt?.includes("destructive"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runAdaptiveWorkflow classifies bugfix and activates systematic debugging", async () => {
  const dir = await createTempRepo({
    "package.json": JSON.stringify({
      name: "calc",
      scripts: { test: "node --version" },
    }),
  });

  try {
    const result = await runAdaptiveWorkflow({
      task: "fix crash when adding negative integers",
      cwd: dir,
    });

    assert.equal(result.taskClassification.class, "bugfix");
    assert.ok(result.capabilities.selected.some((c) => c.id === SYSTEMATIC_DEBUGGING_RECIPE.id));
    assert.equal(result.status, "completed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
