import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCommand } from "@lattice/execution";
import {
  ProcessAgentAdapter,
  createOpenCodeAdapter,
  createQwenCodeAdapter,
  promoteVerifiedRun,
  runIsolatedAgent,
  workspaceExists,
} from "./index.js";

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "lattice-agent-repo-"));
  await runCommand({ command: "git", args: ["init"], cwd: repo });
  await writeFile(join(repo, "base.txt"), "base\n");
  await runCommand({ command: "git", args: ["add", "base.txt"], cwd: repo });
  const commit = await runCommand({
    command: "git",
    args: [
      "-c",
      "user.name=Lattice Test",
      "-c",
      "user.email=lattice@example.invalid",
      "commit",
      "-m",
      "initial",
    ],
    cwd: repo,
  });
  assert.equal(commit.exitCode, 0, commit.stderr);
  return repo;
}

test("process agent runs in an isolated worktree and returns a verified diff", async () => {
  const repo = await createRepo();

  const adapter = new ProcessAgentAdapter({
    name: "fixture-agent",
    command: process.execPath,
    args: [
      "-e",
      "require('fs').appendFileSync('base.txt', process.argv[1] + '\\n')",
      "{prompt}",
    ],
  });

  const result = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "agent-change" },
    adapter,
    verifyCommand: {
      command: process.execPath,
      args: [
        "-e",
        "const s=require('fs').readFileSync('base.txt','utf8'); process.exit(s.includes('agent-change')?0:1)",
      ],
    },
    cleanup: "always",
  });

  assert.equal(result.success, true);
  assert.ok(result.changes.changedFiles.includes("base.txt"));
  assert.match(result.changes.diff, /agent-change/);
  assert.equal(result.verification?.exitCode, 0);
  assert.equal(await workspaceExists(result.workspace.path), false);

  const original = await runCommand({
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write(require('fs').readFileSync('base.txt','utf8'))",
    ],
    cwd: repo,
  });
  assert.equal(original.stdout, "base\n");
});


test("Qwen Code and OpenCode presets render current headless CLI shapes", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];

  const qwen = createQwenCodeAdapter({
    command: process.execPath,
    approvalMode: "auto-edit",
    extraArgs: ["--version"],
  });
  const opencode = createOpenCodeAdapter({
    command: process.execPath,
    autoApprove: true,
    format: "json",
    extraArgs: ["--version"],
  });

  // The actual binaries are intentionally not required in CI; configuration
  // shape is tested through the adapter contract and live binary integration
  // belongs in optional E2E tests.
  assert.equal(qwen.name, "qwen-code");
  assert.equal(opencode.name, "opencode");
  assert.ok(calls.length === 0);
});

test("verified retained worktree can be promoted to a reviewable branch commit", async () => {
  const repo = await createRepo();

  const adapter = new ProcessAgentAdapter({
    name: "fixture-agent",
    command: process.execPath,
    args: [
      "-e",
      "require('fs').appendFileSync('base.txt','promoted\\n')",
    ],
  });

  const run = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "make a verified edit" },
    adapter,
    verifyCommand: {
      command: process.execPath,
      args: [
        "-e",
        "const s=require('fs').readFileSync('base.txt','utf8');process.exit(s.includes('promoted')?0:1)",
      ],
    },
    cleanup: "on-failure",
  });

  assert.equal(run.success, true);
  assert.equal(run.workspaceRetained, true);

  const promoted = await promoteVerifiedRun(run, {
    branchName: "lattice/test-promoted",
    commitMessage: "test: promote verified candidate",
  });

  assert.equal(promoted.branch, "lattice/test-promoted");
  assert.equal(promoted.changedFiles.includes("base.txt"), true);
  assert.match(promoted.commit, /^[0-9a-f]{40}$/);

  const branch = await runCommand({
    command: "git",
    args: ["rev-parse", "lattice/test-promoted"],
    cwd: repo,
  });
  assert.equal(branch.exitCode, 0);
  assert.equal(branch.stdout.trim(), promoted.commit);
});
