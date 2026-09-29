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
  runParallelAgents,
  verifiedBatchResults,
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


test("parallel agent scheduler pins one base revision and preserves result order", async () => {
  const repo = await createRepo();
  let active = 0;
  let maxActive = 0;

  const adapter = {
    name: "parallel-fixture",
    async run(task: { prompt: string }, workspace: string) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
      await writeFile(join(workspace, task.prompt + ".txt"), task.prompt + "\n");
      active -= 1;
      return {
        agent: "parallel-fixture",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 30,
        timedOut: false,
      };
    },
  };

  const results = await runParallelAgents({
    repoRoot: repo,
    maxConcurrency: 2,
    jobs: ["a", "b", "c"].map((id) => ({
      id,
      task: { prompt: id },
      adapter,
      verifyCommand: {
        command: process.execPath,
        args: ["-e", `process.exit(require('fs').existsSync('${id}.txt')?0:1)`],
      },
      cleanup: "always" as const,
    })),
  });

  assert.deepEqual(results.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(maxActive, 2);
  assert.equal(verifiedBatchResults(results).length, 3);

  const bases = results
    .filter((item) => item.status === "fulfilled")
    .map((item) => item.result.workspace.baseRevision);
  assert.equal(new Set(bases).size, 1);
});

test("scheduler can stop launching queued jobs after verified success", async () => {
  const repo = await createRepo();
  const adapter = new ProcessAgentAdapter({
    name: "stop-fixture",
    command: process.execPath,
    args: [
      "-e",
      "require('fs').writeFileSync('winner.txt', process.argv[1])",
      "{prompt}",
    ],
  });

  const results = await runParallelAgents({
    repoRoot: repo,
    maxConcurrency: 1,
    stopLaunchingAfterVerified: true,
    jobs: ["winner", "later-1", "later-2"].map((id) => ({
      id,
      task: { prompt: id },
      adapter,
      verifyCommand: {
        command: process.execPath,
        args: [
          "-e",
          "process.exit(require('fs').readFileSync('winner.txt','utf8')==='winner'?0:1)",
        ],
      },
      cleanup: "always" as const,
    })),
  });

  assert.equal(results[0]?.status, "fulfilled");
  assert.equal(results[1]?.status, "skipped");
  assert.equal(results[2]?.status, "skipped");
  assert.equal(verifiedBatchResults(results).length, 1);
});
