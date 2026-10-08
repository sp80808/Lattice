// Tests for the self-dogfood case runner (issue #41), against a throwaway repo
// whose base commit has a failing check and whose "gold" commit fixes it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadLedger, objectiveOutcome } from "../packages/ledger/dist/index.js";
import { runCase, runCommand, snapshot } from "./dogfood-run.mjs";

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "lattice-dogfood-test-"));
  const repo = join(dir, "repo");
  spawnSync("mkdir", [repo]);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "add.sh"), "echo $(( $1 - $2 ))\n");
  writeFileSync(join(repo, "check.sh"), '[ "$(bash add.sh 2 3)" = 5 ]\n');
  writeFileSync(join(repo, "SECRET_FIX_NOTES.md"), "the fix is to use +\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "add.sh"), "echo $(( $1 + $2 ))\n");
  git(repo, "commit", "-q", "-am", "fix");
  const gold = git(repo, "rev-parse", "HEAD");

  const manifestFor = (overrides = {}) => {
    const manifest = {
      schema: "lattice.dogfood.case/v0",
      id: "toy-add",
      version: 1,
      task_class: "verification-integrity",
      repository: "example/toy",
      base_sha: base,
      task_statement: "add.sh returns the wrong sum; make check.sh pass.",
      allowed_tools: ["shell"],
      acceptance: { commands: ["bash check.sh"], must_fail_on_broken_base: true, must_pass_on_fixed_sha: true },
      reference: { gold_fix_sha: gold },
      leakage_guard: {
        exclude_paths_from_context: ["SECRET_FIX_NOTES.md"],
        exclude_commits_from_context: [gold],
        forbid_future_files: true,
      },
      provenance: { source_issue: "#41", recorded_at: "2026-10-08" },
      ...overrides,
    };
    const path = join(dir, `case-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(manifest));
    return path;
  };
  return { dir, repo, base, gold, manifestFor, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("snapshot holds one commit, no gold commit and no excluded paths", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const manifest = JSON.parse(readFileSync(f.manifestFor(), "utf8"));
  const ws = snapshot(f.repo, f.base, manifest, f.dir);
  assert.deepEqual(ws.leaks, []);
  assert.deepEqual(ws.removed, ["SECRET_FIX_NOTES.md"]);
  assert.equal(git(ws.dir, "rev-list", "--all").split("\n").length, 1);
  assert.notEqual(spawnSync("git", ["cat-file", "-e", f.gold], { cwd: ws.dir }).status, 0);
  assert.match(readFileSync(join(ws.dir, "add.sh"), "utf8"), /-/);
  // The snapshot commit depends only on the tree, so reruns are comparable.
  assert.equal(snapshot(f.repo, f.base, manifest, f.dir).head, ws.head);
});

test("calibrate reports discriminating acceptance and writes a ledger-readable run log", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const result = await runCase({ caseRef: f.manifestFor(), source: f.repo, outDir: join(f.dir, "runs") });
  assert.equal(result.verdict, "discriminating", result.reason);
  assert.deepEqual(result.phases.map((p) => p.status), ["failed", "passed"]);
  assert.deepEqual(result.commands, [{ command: "bash check.sh", base: "fail", gold: "pass", discriminates: true }]);

  const events = readFileSync(result.logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((e) => e.type), ["run.started", "tap.created", "tool.completed", "tool.completed", "run.completed"]);
  const [baseRun, goldRun] = events.filter((e) => e.type === "tool.completed").map((e) => e.payload.outcome);
  assert.equal(baseRun.status, "failed");
  assert.equal(goldRun.status, "success");
  assert.equal(goldRun.evidence[0].kind, "command");
  assert.equal(goldRun.evidence[0].verified, true);
  assert.equal(baseRun.evidence[0].verified, false);

  const [run] = await loadLedger([result.logPath]);
  assert.equal(run.repoRevision, f.base);
  assert.deepEqual(objectiveOutcome(run, 0), { linked: true, success: false, experiments: [run.experiments[0]] });
  assert.equal(objectiveOutcome(run, 1).success, true);
});

test("calibrate flags acceptance that passes at the broken base", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const caseRef = f.manifestFor({
    acceptance: { commands: ["true"], must_fail_on_broken_base: true, must_pass_on_fixed_sha: true },
  });
  const result = await runCase({ caseRef, source: f.repo, outDir: join(f.dir, "runs") });
  assert.equal(result.verdict, "not_discriminating");
  assert.match(result.reason, /passes at the broken base/);
  assert.equal(result.ok, false);
});

test("a failing setup step is inconclusive, never a discriminating failure", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const caseRef = f.manifestFor({
    acceptance: { setup: ["exit 3"], commands: ["bash check.sh"], must_fail_on_broken_base: true, must_pass_on_fixed_sha: true },
  });
  const result = await runCase({ caseRef, source: f.repo, outDir: join(f.dir, "runs") });
  assert.equal(result.verdict, "inconclusive");
  assert.match(result.reason, /setup failed: exit 3/);
  assert.deepEqual(result.phases[0].acceptance, []);
});

test("patch mode verifies a correct patch and rejects a wrong one", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const caseRef = f.manifestFor();
  const good = join(f.dir, "good.patch");
  writeFileSync(good, spawnSync("git", ["diff", f.base, f.gold], { cwd: f.repo, encoding: "utf8" }).stdout);
  const verified = await runCase({ caseRef, source: f.repo, mode: "patch", patch: good, outDir: join(f.dir, "runs") });
  assert.equal(verified.verdict, "verified", verified.reason);
  assert.deepEqual(verified.phases[0].changedFiles, ["add.sh"]);

  const noop = join(f.dir, "noop.patch");
  writeFileSync(noop, "diff --git a/README b/README\nnew file mode 100644\n--- /dev/null\n+++ b/README\n@@ -0,0 +1 @@\n+hi\n");
  const failed = await runCase({ caseRef, source: f.repo, mode: "patch", patch: noop, outDir: join(f.dir, "runs") });
  assert.equal(failed.verdict, "failed");

  const broken = join(f.dir, "broken.patch");
  writeFileSync(broken, "not a patch\n");
  const rejected = await runCase({ caseRef, source: f.repo, mode: "patch", patch: broken, outDir: join(f.dir, "runs") });
  assert.equal(rejected.verdict, "inconclusive");
  assert.match(rejected.reason, /patch does not apply/);
});

test("agent mode gets only the task statement and its diff is verified", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const caseRef = f.manifestFor();
  // The agent records what it can see, then fixes the bug.
  const agent = [
    'printf "%s" "$LATTICE_DOGFOOD_TASK" > ../seen-task.txt',
    "cat > ../seen-stdin.txt",
    "ls -a > ../seen-files.txt",
    "env > ../seen-env.txt",
    "sed -i 's/-/+/' add.sh",
  ].join(" && ");
  const result = await runCase({ caseRef, source: f.repo, mode: "agent", agent, keep: true, outDir: join(f.dir, "runs") });
  t.after(() => rmSync(result.workspaces, { recursive: true, force: true }));
  assert.equal(result.verdict, "verified", result.reason);
  assert.deepEqual(result.phases[0].changedFiles, ["add.sh"]);
  assert.match(result.phases[0].patch, /\+echo \$\(\( \$1 \+ \$2 \)\)/);

  const seen = (name) => readFileSync(join(result.workspaces, name), "utf8");
  assert.equal(seen("seen-task.txt"), "add.sh returns the wrong sum; make check.sh pass.");
  assert.equal(seen("seen-stdin.txt"), "add.sh returns the wrong sum; make check.sh pass.");
  assert.doesNotMatch(seen("seen-files.txt"), /SECRET_FIX_NOTES/);
  assert.doesNotMatch(seen("seen-env.txt"), new RegExp(f.gold));
});

test("runCommand kills a command that outlives its timeout", async () => {
  const result = await runCommand("sleep 5 & sleep 5; wait", tmpdir(), { timeoutMs: 200 });
  assert.equal(result.timedOut, true);
  assert.equal(result.passed, false);
  assert.ok(result.durationMs < 4000, `took ${result.durationMs}ms`);
});

test("a source repo missing the frozen commits is an error, not a run", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const caseRef = f.manifestFor({ base_sha: "0".repeat(40) });
  await assert.rejects(runCase({ caseRef, source: f.repo, outDir: join(f.dir, "runs") }), /does not contain 0{40}; fetch example\/toy first/);
});
