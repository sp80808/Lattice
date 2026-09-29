import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCommand } from "@lattice/execution";
import {
  ProcessAgentAdapter,
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
