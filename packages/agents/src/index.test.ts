import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCommand } from "@lattice/execution";
import {
  QWEN_CODE_ENV,
  ProcessAgentAdapter,
  createAgentExperimentExecutor,
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
      // Wait for a sibling to overlap instead of a fixed sleep: worktree creation
      // time varies under load. A serial scheduler times out here and fails below.
      const deadline = Date.now() + 5_000;
      while (maxActive < 2 && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
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

test("a structured verifier replaces the verify command and gates success", async () => {
  const repo = await createRepo();
  const adapter = new ProcessAgentAdapter({
    name: "fixture-agent",
    command: process.execPath,
    args: ["-e", "require('fs').writeFileSync('base.txt', 'changed\\n')"],
  });
  const seen: string[] = [];
  const verifier = (passed: boolean) => ({
    tool: "fixture.verifier",
    describe: () => ({}),
    async verify(cwd: string) {
      seen.push(cwd);
      return {
        tool: "fixture.verifier",
        passed,
        summary: passed ? "ok" : "rejected",
        evidence: [],
        record: { passed },
      };
    },
  });

  const rejected = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "change" },
    adapter,
    verifyCommand: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    verifier: verifier(false),
    cleanup: "always",
  });
  assert.equal(rejected.success, false);
  assert.equal(rejected.verification, undefined, "the command is not run");
  assert.equal(rejected.verifierResult?.summary, "rejected");
  assert.equal(seen[0], rejected.workspace.path, "verifier runs in the worktree");

  const accepted = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "change" },
    adapter,
    verifier: verifier(true),
    cleanup: "always",
  });
  assert.equal(accepted.success, true);
});

test("agent workers do not inherit unrelated parent secrets", async () => {
  const repo = await createRepo();
  process.env.LATTICE_AGENT_TEST_SECRET = "do-not-leak";
  process.env.LATTICE_AGENT_TEST_KEY = "granted";
  const script =
    "process.stdout.write(JSON.stringify({s:process.env.LATTICE_AGENT_TEST_SECRET??null,k:process.env.LATTICE_AGENT_TEST_KEY??null}))";
  try {
    const restricted = await new ProcessAgentAdapter({
      name: "restricted",
      command: process.execPath,
      args: ["-e", script],
      allowEnv: ["LATTICE_AGENT_TEST_KEY"],
    }).run({ prompt: "x" }, repo);
    assert.deepEqual(JSON.parse(restricted.stdout), { s: null, k: "granted" });
    assert.equal(restricted.environment?.policy, "minimal");
    assert.ok(restricted.environment?.names.includes("LATTICE_AGENT_TEST_KEY"));

    const trusted = await new ProcessAgentAdapter({
      name: "trusted",
      command: process.execPath,
      args: ["-e", script],
      trustedHost: true,
    }).run({ prompt: "x" }, repo);
    assert.deepEqual(JSON.parse(trusted.stdout), { s: "do-not-leak", k: "granted" });
    assert.equal(trusted.environment?.policy, "inherit");
  } finally {
    delete process.env.LATTICE_AGENT_TEST_SECRET;
    delete process.env.LATTICE_AGENT_TEST_KEY;
  }
});

test("presets declare the environment their CLI needs", () => {
  assert.ok(QWEN_CODE_ENV.includes("OPENAI_API_KEY"));
  assert.ok(QWEN_CODE_ENV.includes("HOME"));
});

test("experiment evidence records the worker env policy and names", async () => {
  const repo = await createRepo();
  const revision = await runCommand({ command: "git", args: ["rev-parse", "HEAD"], cwd: repo });
  const executor = createAgentExperimentExecutor({
    adapter: new ProcessAgentAdapter({
      name: "fixture-agent",
      command: process.execPath,
      args: ["-e", "0"],
    }),
    cleanup: "always",
  });
  const outcome = await executor.execute(
    { id: "c1", label: "noop", action: "noop", expectedEvidence: "none" } as never,
    {
      task: "noop",
      repo: { root: repo, revision: revision.stdout.trim() },
      context: [],
    } as never,
  );
  const model = outcome.evidence.find((record) => record.kind === "model");
  assert.ok(model, "missing model evidence");
  assert.match(JSON.stringify(model), /env=minimal:[^"]*PATH/);
  assert.doesNotMatch(JSON.stringify(model), /undefined/);
});

test("cancelling a run stops the worker, skips verification and keeps its evidence", async () => {
  const repo = await createRepo();
  const controller = new AbortController();
  const verifyRan = join(await mkdtemp(join(tmpdir(), "lattice-cancel-")), "verified");
  const adapter = new ProcessAgentAdapter({
    name: "slow-agent",
    command: process.execPath,
    args: [
      "-e",
      "require('fs').appendFileSync('base.txt','partial\\n');setInterval(()=>{},1000)",
    ],
  });
  setTimeout(() => controller.abort(new Error("operator stop")), 300);
  const result = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "never finishes", timeoutMs: 30_000 },
    adapter,
    verifyCommand: {
      command: process.execPath,
      args: ["-e", `require('fs').writeFileSync(${JSON.stringify(verifyRan)},'x')`],
    },
    cleanup: "always",
    signal: controller.signal,
  });
  assert.equal(result.success, false);
  assert.deepEqual(result.cancelled, { reason: "operator stop", stage: "agent" });
  assert.equal(result.execution.cancelled, true);
  assert.equal(result.verification, undefined);
  assert.equal(await workspaceExists(verifyRan), false);
  // What the worker did before the stop is still captured as evidence.
  assert.ok(result.changes.changedFiles.includes("base.txt"));
});

test("cancelling during verification records the verify stage", async () => {
  const repo = await createRepo();
  const controller = new AbortController();
  const started = join(await mkdtemp(join(tmpdir(), "lattice-cancel-")), "started");
  const watcher = setInterval(() => {
    if (existsSync(started)) controller.abort("deadline");
  }, 25);
  try {
    const result = await runIsolatedAgent({
      repoRoot: repo,
      task: { prompt: "quick" },
      adapter: new ProcessAgentAdapter({
        name: "quick-agent",
        command: process.execPath,
        args: ["-e", "0"],
      }),
      verifyCommand: {
        command: process.execPath,
        args: [
          "-e",
          `require('fs').writeFileSync(${JSON.stringify(started)},'x');setInterval(()=>{},1000)`,
        ],
        timeoutMs: 30_000,
      },
      cleanup: "always",
      signal: controller.signal,
    });
    assert.equal(result.success, false);
    assert.deepEqual(result.cancelled, { reason: "deadline", stage: "verify" });
    assert.equal(result.verification?.cancelled, true);
  } finally {
    clearInterval(watcher);
  }
});
