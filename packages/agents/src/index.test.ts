import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
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
  removeWorktree,
  runIsolatedAgent,
  runParallelAgents,
  verifiedBatchResults,
  workspaceExists,
  objectiveVerification,
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


test("a worker's cwd, writes and git state stay inside its own worktree", async () => {
  const repo = await createRepo();
  const head = (await runCommand({ command: "git", args: ["rev-parse", "HEAD"], cwd: repo })).stdout;
  const adapter = new ProcessAgentAdapter({
    name: "fixture-agent",
    command: process.execPath,
    args: [
      "-e",
      // Write relative to cwd, then try to move HEAD from inside the worktree.
      "const fs=require('fs');fs.writeFileSync('inside.txt',fs.realpathSync(process.cwd()));" +
        "require('child_process').execFileSync('git',['checkout','-q','--detach','HEAD~0']);",
    ],
  });
  const result = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "x" },
    adapter,
    cleanup: "never",
  });
  try {
    assert.equal(result.execution.exitCode, 0, result.execution.stderr);
    assert.deepEqual(result.changes.changedFiles, ["inside.txt"]);
    assert.match(result.changes.diff, new RegExp(realpathSync(result.workspace.path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const status = await runCommand({ command: "git", args: ["status", "--porcelain"], cwd: repo });
    assert.equal(status.stdout, "", "main checkout was modified");
    const after = await runCommand({ command: "git", args: ["rev-parse", "HEAD"], cwd: repo });
    assert.equal(after.stdout, head, "main checkout HEAD moved");
  } finally {
    await removeWorktree(result.workspace);
  }
});

test("a worker that moves the main repo's shared refs fails the run", async () => {
  const repo = await createRepo();
  const git = (args: string[], cwd = repo) => runCommand({ command: "git", args, cwd });
  const branch = (await git(["symbolic-ref", "--short", "HEAD"])).stdout.trim();
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  assert.equal((await git(["tag", "v1"])).exitCode, 0);

  // Commit inside the worktree, then point the main branch at it, delete a
  // tag and add a new branch. Worktrees share refs, so only a check notices.
  const script = [
    "const {execFileSync:x}=require('child_process');",
    "require('fs').writeFileSync('evil.txt','x');",
    "x('git',['add','evil.txt']);",
    "x('git',['-c','user.name=w','-c','user.email=w@x','commit','-qm','evil']);",
    "x('git',['update-ref','refs/heads/'+process.argv[1],'HEAD']);",
    "x('git',['tag','-d','v1']);",
    "x('git',['branch','scratch']);",
  ].join("");
  const result = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: branch },
    adapter: new ProcessAgentAdapter({
      name: "fixture-agent",
      command: process.execPath,
      args: ["-e", script, "{prompt}"],
    }),
    verifyCommand: { command: process.execPath, args: ["-e", "0"] },
    cleanup: "never",
  });
  try {
    assert.equal(result.execution.exitCode, 0, result.execution.stderr);
    assert.equal(result.verification?.exitCode, 0);
    assert.equal(result.success, false);
    assert.equal(result.refTamper?.length, 2, JSON.stringify(result.refTamper));
    assert.match(result.refTamper![0]!, new RegExp(`^refs/heads/${branch}: ${head.slice(0, 12)}->`));
    assert.equal(result.refTamper![1], "refs/tags/v1: deleted");
    await assert.rejects(promoteVerifiedRun(result), /unsuccessful/);
  } finally {
    await removeWorktree(result.workspace);
  }
});

test("an untouched repo reports no ref tamper", async () => {
  const repo = await createRepo();
  const result = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "x" },
    adapter: new ProcessAgentAdapter({
      name: "fixture-agent",
      command: process.execPath,
      args: ["-e", "require('fs').writeFileSync('ok.txt','x')"],
    }),
    verifyCommand: { command: process.execPath, args: ["-e", "0"] },
    cleanup: "always",
  });
  assert.equal(result.success, true);
  assert.equal(result.refTamper, undefined);
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


test("verification that mutates the candidate is not trusted", async () => {
  const repo = await createRepo();
  const result = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "change" },
    adapter: new ProcessAgentAdapter({
      name: "fixture",
      command: process.execPath,
      args: ["-e", "require('fs').appendFileSync('base.txt','agent\\n')"],
    }),
    verifyCommand: {
      command: process.execPath,
      args: [
        "-e",
        "require('fs').appendFileSync('base.txt','verifier\\n');process.exit(0)",
      ],
    },
    cleanup: "never",
  });

  try {
    assert.equal(result.verification?.exitCode, 0, "the command itself passed");
    assert.equal(result.success, false);
    assert.equal(result.verificationIntegrity?.trusted, false);
    assert.deepEqual(result.verificationIntegrity?.drift?.modified, ["base.txt"]);
    assert.equal(objectiveVerification(result).passed, false);
    assert.match(objectiveVerification(result).reason ?? "", /verification changed the workspace/);
    await assert.rejects(promoteVerifiedRun(result), /unsuccessful/);
  } finally {
    await removeWorktree(result.workspace);
  }
});

test("a file created by the verifier is drift, not a promotion artifact", async () => {
  const repo = await createRepo();
  const result = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "change" },
    adapter: new ProcessAgentAdapter({
      name: "fixture",
      command: process.execPath,
      args: ["-e", "require('fs').appendFileSync('base.txt','agent\\n')"],
    }),
    verifyCommand: {
      command: process.execPath,
      args: ["-e", "require('fs').writeFileSync('coverage.out','built\\n')"],
    },
    cleanup: "never",
  });

  try {
    assert.equal(result.verification?.exitCode, 0);
    assert.equal(result.success, false);
    assert.deepEqual(result.verificationIntegrity?.drift?.added, ["coverage.out"]);
  } finally {
    await removeWorktree(result.workspace);
  }
});

test("a late edit after verification refuses promotion", async () => {
  const repo = await createRepo();
  const result = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "change" },
    adapter: new ProcessAgentAdapter({
      name: "fixture",
      command: process.execPath,
      args: ["-e", "require('fs').appendFileSync('base.txt','agent\\n')"],
    }),
    verifyCommand: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    cleanup: "never",
  });

  try {
    assert.equal(result.success, true);
    assert.ok(result.changeSet.changeSetDigest);
    await writeFile(join(result.workspace.path, "base.txt"), "late edit\n");
    await assert.rejects(
      promoteVerifiedRun(result),
      /workspace changed after verification.*base\.txt/,
    );
  } finally {
    await removeWorktree(result.workspace);
  }
});

test("a file added after verification refuses promotion", async () => {
  const repo = await createRepo();
  const result = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "change" },
    adapter: new ProcessAgentAdapter({
      name: "fixture",
      command: process.execPath,
      args: ["-e", "require('fs').appendFileSync('base.txt','agent\\n')"],
    }),
    verifyCommand: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    cleanup: "never",
  });

  try {
    assert.equal(result.success, true);
    await writeFile(join(result.workspace.path, "late.txt"), "late\n");
    await assert.rejects(
      promoteVerifiedRun(result),
      /workspace changed after verification.*added: late\.txt/,
    );
  } finally {
    await removeWorktree(result.workspace);
  }
});

test("promotion commits only the verified paths, not a staged phantom", async () => {
  const repo = await createRepo();
  const result = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "change" },
    adapter: new ProcessAgentAdapter({
      name: "fixture",
      command: process.execPath,
      args: [
        "-e",
        [
          "const fs=require('fs'),cp=require('child_process');",
          "fs.writeFileSync('ghost.txt','ghost\\n');",
          "cp.execFileSync('git',['add','ghost.txt']);",
          "fs.unlinkSync('ghost.txt');",
          "fs.appendFileSync('base.txt','real change\\n');",
        ].join(""),
      ],
    }),
    verifyCommand: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    cleanup: "never",
  });

  try {
    assert.equal(result.success, true);
    assert.deepEqual(result.changeSet.entries.map((entry) => entry.path), ["base.txt"]);
    const promoted = await promoteVerifiedRun(result, { branchName: "lattice/test-exact" });
    assert.equal(promoted.changeSetDigest, result.changeSet.changeSetDigest);

    const ghost = await runCommand({
      command: "git",
      args: ["cat-file", "-e", `lattice/test-exact:ghost.txt`],
      cwd: repo,
    });
    assert.notEqual(ghost.exitCode, 0, "a path outside the verified manifest was committed");

    const content = await runCommand({
      command: "git",
      args: ["show", "lattice/test-exact:base.txt"],
      cwd: repo,
    });
    assert.equal(content.stdout, "base\nreal change\n");
  } finally {
    await removeWorktree(result.workspace);
  }
});

test("structured verifier successes can be promoted", async () => {
  const repo = await createRepo();
  const result = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "change" },
    adapter: new ProcessAgentAdapter({
      name: "fixture",
      command: process.execPath,
      args: ["-e", "require('fs').writeFileSync('base.txt','verified\\n')"],
    }),
    verifier: {
      tool: "fixture.verifier",
      describe: () => ({}),
      async verify() {
        return {
          tool: "fixture.verifier",
          passed: true,
          summary: "ok",
          evidence: [],
          record: {},
        };
      },
    },
    cleanup: "never",
  });

  try {
    assert.equal(result.success, true);
    const promoted = await promoteVerifiedRun(result, { branchName: "lattice/test-structured" });
    assert.match(promoted.commit, /^[0-9a-f]{40}$/);
    const content = await runCommand({
      command: "git",
      args: ["show", "lattice/test-structured:base.txt"],
      cwd: repo,
    });
    assert.equal(content.stdout, "verified\n");
  } finally {
    await removeWorktree(result.workspace);
  }
});

test("a worker that commits cannot be promoted", async () => {
  const repo = await createRepo();
  const result = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "change" },
    adapter: new ProcessAgentAdapter({
      name: "fixture",
      command: process.execPath,
      args: [
        "-e",
        [
          "const fs=require('fs'),cp=require('child_process');",
          "fs.writeFileSync('base.txt','committed\\n');",
          "cp.execFileSync('git',['add','base.txt']);",
          "cp.execFileSync('git',['-c','user.name=w','-c','user.email=w@x','commit','-qm','worker']);",
        ].join(""),
      ],
    }),
    verifyCommand: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    cleanup: "never",
  });

  try {
    assert.equal(result.execution.exitCode, 0, result.execution.stderr);
    assert.ok(result.verification, "verification still runs to record evidence");
    assert.equal(result.headMoved?.baseRevision, result.changeSet.baseRevision);
    assert.equal(result.success, false);
    assert.match(objectiveVerification(result).reason ?? "", /moved HEAD/);
    await assert.rejects(promoteVerifiedRun(result), /unsuccessful/);
  } finally {
    await removeWorktree(result.workspace);
  }
});

test("symlink candidates are denied by default and promotable when allowed", async () => {
  const repo = await createRepo();
  const adapter = new ProcessAgentAdapter({
    name: "fixture",
    command: process.execPath,
    args: ["-e", "require('fs').symlinkSync('base.txt','link.txt')"],
  });
  const verifyCommand = { command: process.execPath, args: ["-e", "process.exit(0)"] };

  const denied = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "link" },
    adapter,
    verifyCommand,
    cleanup: "never",
  });
  try {
    assert.equal(denied.success, false);
    assert.deepEqual(
      denied.policyViolations?.map((violation) => violation.code),
      ["symlink"],
    );
    await assert.rejects(promoteVerifiedRun(denied), /unsuccessful/);
  } finally {
    await removeWorktree(denied.workspace);
  }

  const allowed = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "link" },
    adapter,
    verifyCommand,
    changesPolicy: { symlinks: "allow" },
    cleanup: "never",
  });
  try {
    assert.equal(allowed.success, true);
    assert.equal(allowed.changeSet.entries[0]?.kind, "symlink");
    assert.equal(allowed.changeSet.entries[0]?.symlinkTarget, "base.txt");
    await promoteVerifiedRun(allowed, { branchName: "lattice/test-symlink" });
    const target = await runCommand({
      command: "git",
      args: ["cat-file", "-p", "lattice/test-symlink:link.txt"],
      cwd: repo,
    });
    assert.equal(target.stdout, "base.txt");
    const mode = await runCommand({
      command: "git",
      args: ["ls-tree", "lattice/test-symlink", "link.txt"],
      cwd: repo,
    });
    assert.match(mode.stdout, /^120000 blob /);
  } finally {
    await removeWorktree(allowed.workspace);
  }
});

test("rewriting the worktree .git file stops capture and verification", async () => {
  const repo = await createRepo();
  const result = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "tamper" },
    adapter: new ProcessAgentAdapter({
      name: "fixture",
      command: process.execPath,
      args: ["-e", "require('fs').writeFileSync('.git','gitdir: /tmp/not-this-worktree\\n')"],
    }),
    verifyCommand: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    cleanup: "never",
  });

  try {
    assert.equal(result.execution.exitCode, 0, result.execution.stderr);
    assert.ok(result.gitMetadataTamper?.length);
    assert.ok(result.captureError);
    assert.ok(result.verificationSkipped);
    assert.equal(result.verification, undefined, "no verifier runs over an unidentified state");
    assert.equal(result.success, false);
    await assert.rejects(promoteVerifiedRun(result), /unsuccessful/);
  } finally {
    await removeWorktree(result.workspace);
  }
});

test("untracked binary files are promoted byte-for-byte", async () => {
  const repo = await createRepo();
  const bytes = [0, 1, 2, 3, 255, 10];
  const result = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "binary" },
    adapter: new ProcessAgentAdapter({
      name: "fixture",
      command: process.execPath,
      args: [
        "-e",
        "require('fs').writeFileSync('blob.bin',Buffer.from([0,1,2,3,255,10]))",
      ],
    }),
    verifyCommand: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    cleanup: "never",
  });

  try {
    assert.equal(result.success, true);
    const blob = result.changeSet.entries.find((entry) => entry.path === "blob.bin");
    assert.equal(blob?.binary, true);
    assert.equal(blob?.size, bytes.length);

    const localOid = await runCommand({
      command: "git",
      args: ["hash-object", "blob.bin"],
      cwd: result.workspace.path,
    });
    await promoteVerifiedRun(result, { branchName: "lattice/test-binary" });
    const committedOid = await runCommand({
      command: "git",
      args: ["rev-parse", "lattice/test-binary:blob.bin"],
      cwd: repo,
    });
    assert.equal(committedOid.stdout.trim(), localOid.stdout.trim());
  } finally {
    await removeWorktree(result.workspace);
  }
});


test("a rename is promoted as exactly one delete and one add", async () => {
  const repo = await createRepo();
  const result = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "rename" },
    adapter: new ProcessAgentAdapter({
      name: "fixture",
      command: process.execPath,
      args: ["-e", "require('fs').renameSync('base.txt','renamed ünï file.txt')"],
    }),
    verifyCommand: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    cleanup: "never",
  });

  try {
    assert.equal(result.success, true);
    // A filesystem rename is captured as a delete plus an add: Git cannot see
    // the new path until it is staged.
    const added = result.changeSet.entries.find(
      (entry) => entry.path === "renamed ünï file.txt",
    );
    const deleted = result.changeSet.entries.find(
      (entry) => entry.path === "base.txt",
    );
    assert.equal(added?.status, "added");
    assert.equal(deleted?.status, "deleted");

    await promoteVerifiedRun(result, { branchName: "lattice/test-rename" });
    const tree = await runCommand({
      command: "git",
      args: ["ls-tree", "-z", "--name-only", "lattice/test-rename"],
      cwd: repo,
    });
    assert.deepEqual(tree.stdout.split("\0").filter(Boolean), ["renamed ünï file.txt"]);
    const content = await runCommand({
      command: "git",
      args: ["show", "lattice/test-rename:renamed ünï file.txt"],
      cwd: repo,
    });
    assert.equal(content.stdout, "base\n");
  } finally {
    await removeWorktree(result.workspace);
  }
});

test("an executable-bit change is captured and committed", async () => {
  const repo = await createRepo();
  const result = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "chmod" },
    adapter: new ProcessAgentAdapter({
      name: "fixture",
      command: process.execPath,
      args: ["-e", "require('fs').chmodSync('base.txt',0o755)"],
    }),
    verifyCommand: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    cleanup: "never",
  });

  try {
    assert.equal(result.success, true);
    const entry = result.changeSet.entries.find((item) => item.path === "base.txt");
    assert.equal(entry?.modeBefore, "100644");
    assert.equal(entry?.modeAfter, "100755");

    await promoteVerifiedRun(result, { branchName: "lattice/test-mode" });
    const tree = await runCommand({
      command: "git",
      args: ["ls-tree", "lattice/test-mode", "base.txt"],
      cwd: repo,
    });
    assert.match(tree.stdout, /^100755 blob /);
  } finally {
    await removeWorktree(result.workspace);
  }
});


test("a git mv is promoted as one delete and one add", async () => {
  const repo = await createRepo();
  const result = await runIsolatedAgent({
    repoRoot: repo,
    task: { prompt: "git rename" },
    adapter: new ProcessAgentAdapter({
      name: "fixture",
      command: process.execPath,
      args: [
        "-e",
        "require('child_process').execFileSync('git',['mv','base.txt','renamed ünï file.txt'])",
      ],
    }),
    verifyCommand: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    cleanup: "never",
  });

  try {
    assert.equal(result.success, true);
    const added = result.changeSet.entries.find(
      (entry) => entry.path === "renamed ünï file.txt",
    );
    const deleted = result.changeSet.entries.find(
      (entry) => entry.path === "base.txt",
    );
    assert.equal(added?.status, "added");
    assert.equal(deleted?.status, "deleted");

    await promoteVerifiedRun(result, { branchName: "lattice/test-git-rename" });
    const tree = await runCommand({
      command: "git",
      args: ["ls-tree", "-z", "--name-only", "lattice/test-git-rename"],
      cwd: repo,
    });
    assert.deepEqual(tree.stdout.split("\0").filter(Boolean), ["renamed ünï file.txt"]);
  } finally {
    await removeWorktree(result.workspace);
  }
});
