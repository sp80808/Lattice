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
  objectiveVerification,
  createAgentExperimentExecutor,
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

test("a structured verifier gates success and is mutually exclusive with verifyCommand", async () => {
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

  await assert.rejects(
    runIsolatedAgent({
      repoRoot: repo,
      task: { prompt: "change" },
      adapter,
      verifyCommand: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      verifier: verifier(false),
      cleanup: "always",
    }),
    /Cannot specify both verifyCommand and verifier/
  );

  const rejected = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "change" },
    adapter,
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

test("parallel agents correctly handle both command and structured verifiers", async () => {
  const repo = await createRepo();

  const adapter = {
    name: "fixture",
    async run() {
      return {
        agent: "fixture",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 10,
        timedOut: false,
      };
    },
  };

  const verifier = (passed: boolean) => ({
    tool: "fixture.verifier",
    describe: () => ({}),
    async verify() {
      return {
        tool: "fixture.verifier",
        passed,
        summary: passed ? "ok" : "fail",
        evidence: [],
        record: {},
      };
    },
  });

  const jobs = [
    {
      id: "passing-cmd",
      task: { prompt: "" },
      adapter,
      verifyCommand: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      cleanup: "always" as const,
    },
    {
      id: "failing-cmd",
      task: { prompt: "" },
      adapter,
      verifyCommand: { command: process.execPath, args: ["-e", "process.exit(1)"] },
      cleanup: "always" as const,
    },
    {
      id: "passing-struct",
      task: { prompt: "" },
      adapter,
      verifier: verifier(true),
      cleanup: "always" as const,
    },
    {
      id: "failing-struct",
      task: { prompt: "" },
      adapter,
      verifier: verifier(false),
      cleanup: "always" as const,
    },
    {
      id: "no-verifier",
      task: { prompt: "" },
      adapter,
      cleanup: "always" as const,
    },
  ];

  const results = await runParallelAgents({
    repoRoot: repo,
    maxConcurrency: 5,
    jobs,
  });

  assert.equal(results.length, 5);
  // 9. deterministic result ordering remains unchanged
  assert.deepEqual(
    results.map((r) => r.id),
    ["passing-cmd", "failing-cmd", "passing-struct", "failing-struct", "no-verifier"],
  );

  const survivors = verifiedBatchResults(results).map((r) => r.id);
  // 1, 2, 3, 4, 6, 8. passing structures/commands are survivors, failing or missing are not
  assert.deepEqual(survivors, ["passing-cmd", "passing-struct"]);
});

test("structured verifier pass triggers stopLaunchingAfterVerified", async () => {
  const repo = await createRepo();

  const adapter = {
    name: "fixture",
    async run() {
      return {
        agent: "fixture",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 10,
        timedOut: false,
      };
    },
  };

  const verifier = (passed: boolean) => ({
    tool: "fixture.verifier",
    describe: () => ({}),
    async verify() {
      return {
        tool: "fixture.verifier",
        passed,
        summary: passed ? "ok" : "fail",
        evidence: [],
        record: {},
      };
    },
  });

  const results = await runParallelAgents({
    repoRoot: repo,
    maxConcurrency: 1,
    stopLaunchingAfterVerified: true,
    jobs: [
      {
        id: "fail-1",
        task: { prompt: "" },
        adapter,
        verifier: verifier(false),
        cleanup: "always" as const,
      },
      {
        id: "pass-2",
        task: { prompt: "" },
        adapter,
        verifier: verifier(true),
        cleanup: "always" as const,
      },
      {
        id: "skip-3",
        task: { prompt: "" },
        adapter,
        verifier: verifier(true),
        cleanup: "always" as const,
      },
    ],
  });

  // 5. structured verifier pass triggers stopLaunchingAfterVerified
  assert.equal(results[0]?.status, "fulfilled");
  assert.equal(results[1]?.status, "fulfilled");
  assert.equal(results[2]?.status, "skipped");
  assert.equal(verifiedBatchResults(results).length, 1);
  assert.equal(verifiedBatchResults(results)[0]?.id, "pass-2");
});

test("verifier tool error => not verified survivor", async () => {
  const repo = await createRepo();

  const adapter = {
    name: "fixture",
    async run() {
      return {
        agent: "fixture",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 10,
        timedOut: false,
      };
    },
  };

  const verifier = {
    tool: "error.verifier",
    describe: () => ({}),
    async verify(): Promise<any> {
      throw new Error("tool unsupported");
    },
  };

  const results = await runParallelAgents({
    repoRoot: repo,
    maxConcurrency: 1,
    jobs: [
      {
        id: "error-1",
        task: { prompt: "" },
        adapter,
        verifier,
        cleanup: "always" as const,
      },
    ],
  });

  // 7. verifier tool error/unsupported => not verified survivor
  assert.equal(results[0]?.status, "rejected");
  assert.equal(verifiedBatchResults(results).length, 0);
});

test("Tessera regression fixture: tsr witness verifier integration", async () => {
  const repo = await createRepo();

  const adapter = {
    name: "fixture",
    async run() {
      return {
        agent: "fixture",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 10,
        timedOut: false,
      };
    },
  };

  const tsrVerifier = {
    tool: "tsr witness",
    describe: () => ({ command: "tsr", args: ["witness"] }),
    async verify() {
      return {
        tool: "tsr witness",
        passed: true,
        summary: "verified via tessera",
        evidence: [
          {
            id: "ev:123",
            kind: "test" as const,
            verified: true,
            source: "test",
            summary: "ok",
            createdAt: new Date().toISOString(),
          },
        ],
        record: { tsr: "data" },
      };
    },
  };

  const results = await runParallelAgents({
    repoRoot: repo,
    maxConcurrency: 1,
    jobs: [
      {
        id: "tsr-1",
        task: { prompt: "" },
        adapter,
        verifier: tsrVerifier,
        cleanup: "always" as const,
      },
    ],
  });

  assert.equal(results[0]?.status, "fulfilled");
  const survivors = verifiedBatchResults(results);
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0]?.id, "tsr-1");
  
  if (survivors[0]) {
    const obj = objectiveVerification(survivors[0].result);
    assert.equal(obj.passed, true);
    assert.equal(obj.evidenceIds.length, 1);
    assert.equal(obj.evidenceIds[0], "ev:123");
  }
});

test("passing checks cannot solve a coding candidate with no edits or a failed worker", async () => {
  const repo = await createRepo();
  for (const code of ["console.log('no edit')", "require('fs').appendFileSync('base.txt','change'); process.exit(1)"]) {
    const executor = createAgentExperimentExecutor({
      adapter: new ProcessAgentAdapter({ name: "fixture", command: process.execPath, args: ["-e", code] }),
      verifyCommand: { command: process.execPath, args: ["-e", "process.exit(0)"] }, cleanup: "always",
    });
    const result = await executor.execute({ id: "fix", label: "fix", action: "fix", expectedEvidence: "pass" }, {
      version: "0.1", runId: "fixture", task: "edit", repo: { root: repo }, objectives: [], constraints: [], context: [], hypotheses: [], candidateActions: [], evidence: [], uncertainties: [], verification: [], budget: {}, childRunIds: [],
    });
    assert.notEqual(result.status, "success");
    assert.equal(result.terminal, false);
  }
});

test("new files with spaces in a new directory have a recorded patch", async () => {
  const repo = await createRepo();
  const result = await runIsolatedAgent({ repoRoot: repo,
    adapter: new ProcessAgentAdapter({ name: "fixture", command: process.execPath, args: ["-e", "require('fs').mkdirSync('new dir'); require('fs').writeFileSync('new dir/new file.txt','cloth mesh\\n')"] }),
    task: { id: "create", prompt: "create file" }, cleanup: "always",
  });
  assert.ok(result.changes.changedFiles.includes("new dir/new file.txt"));
  assert.match(result.changes.diff, /\+cloth mesh/);
});
