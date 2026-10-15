// Tests for the pinned dogfood benchmark (issue #41), on a throwaway repo whose
// base commit has a failing check and whose "gold" commit fixes it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentCommand, main, summarizeTranscript } from "./dogfood-bench.mjs";

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(agents) {
  const dir = mkdtempSync(join(tmpdir(), "lattice-dogfood-bench-test-"));
  const repo = join(dir, "repo");
  spawnSync("mkdir", [repo]);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "add.sh"), "echo $(( $1 - $2 ))\n");
  writeFileSync(join(repo, "check.sh"), '[ "$(bash add.sh 2 3)" = 5 ]\n');
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "add.sh"), "echo $(( $1 + $2 ))\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fix");
  const gold = git(repo, "rev-parse", "HEAD");
  writeFileSync(
    join(dir, "toy.json"),
    JSON.stringify({
      schema: "lattice.dogfood.case/v0",
      id: "toy-add",
      version: 1,
      task_class: "verification-integrity",
      repository: "example/toy",
      base_sha: base,
      task_statement: "add.sh returns the wrong sum; make check.sh pass.",
      allowed_tools: ["shell"],
      acceptance: { commands: ["bash check.sh"], must_fail_on_broken_base: true, must_pass_on_fixed_sha: true },
      reference: { gold_fix_sha: gold, gold_pr: "https://example.invalid/toy/pull/1" },
      leakage_guard: { exclude_paths_from_context: [], exclude_commits_from_context: [gold], forbid_future_files: true },
      provenance: { source_issue: "#41", recorded_at: "2026-10-15" },
    }),
  );
  const suite = join(dir, "suite.json");
  writeFileSync(suite, JSON.stringify({ schema: "lattice.dogfood.bench/v1", id: "toy-bench", cases: ["toy.json"], attempts: 2, timeout_ms: 30000, agents }));
  const out = join(dir, "out");
  const args = [suite, "--source", `example/toy=${repo}`, "--out", out];
  return { dir, repo, gold, out, args, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const runs = (out) => readFileSync(join(out, "runs.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

test("bench calibrates, scores each agent per attempt and writes a report", async (t) => {
  const f = fixture([
    { id: "noop", kind: "control", command: "true" },
    { id: "fixer", kind: "command", command: "sed -i 's/-/+/' add.sh" },
  ]);
  t.after(f.cleanup);
  await main(f.args);
  const calibration = JSON.parse(readFileSync(join(f.out, "calibration.json"), "utf8"));
  assert.deepEqual(calibration.map((c) => [c.case, c.verdict]), [["toy-add", "discriminating"]]);

  const results = runs(f.out);
  assert.deepEqual(
    results.map((r) => [r.agent, r.attempt, r.verdict]),
    [["noop", 1, "failed"], ["fixer", 1, "verified"], ["noop", 2, "failed"], ["fixer", 2, "verified"]],
  );
  assert.deepEqual(results[1].changedFiles, ["add.sh"]);
  assert.match(readFileSync(results[1].patch, "utf8"), /\+echo \$\(\( \$1 \+ \$2 \)\)/);
  const report = readFileSync(join(f.out, "REPORT.md"), "utf8");
  assert.match(report, /\| `noop` \| 0\/2 \(0%\) \| 0\/2 \(✗✗\)/);
  assert.match(report, /\| `fixer` \| 2\/2 \(100%\) \| 2\/2 \(✓✓\)/);
  assert.doesNotMatch(report, /Partial run/);
});

test("a rerun resumes instead of repeating finished attempts", async (t) => {
  const f = fixture([{ id: "fixer", kind: "command", command: "echo ran >> ../count && sed -i 's/-/+/' add.sh" }]);
  t.after(f.cleanup);
  await main([...f.args, "--attempts", "1"]);
  assert.match(readFileSync(join(f.out, "REPORT.md"), "utf8"), /Partial run/);
  await main(f.args);
  assert.deepEqual(runs(f.out).map((r) => r.attempt), [1, 2]);
});

test("an agent that reaches the gold fix is marked contaminated and not solved", async (t) => {
  const f = fixture([]);
  t.after(f.cleanup);
  // The agent reads the source clone's history and copies the fix from it.
  const suitePath = f.args[0];
  const suite = JSON.parse(readFileSync(suitePath, "utf8"));
  suite.agents = [{ id: "peeker", kind: "command", command: `git -C ${f.repo} log --format=%H && git -C ${f.repo} show HEAD:add.sh > add.sh` }];
  suite.attempts = 1;
  writeFileSync(suitePath, JSON.stringify(suite));
  await main([...f.args, "--skip-calibration"]);
  const [run] = runs(f.out);
  assert.equal(run.verdict, "verified");
  assert.ok(run.contamination.length > 0, "expected contamination markers");
  assert.match(readFileSync(join(f.out, "REPORT.md"), "utf8"), /\| `peeker` \| 0\/1 \(0%\)/);
});

test("a case whose acceptance does not discriminate is refused", async (t) => {
  const f = fixture([{ id: "noop", kind: "control", command: "true" }]);
  t.after(f.cleanup);
  const casePath = join(f.dir, "toy.json");
  const manifest = JSON.parse(readFileSync(casePath, "utf8"));
  manifest.acceptance.commands = ["true"];
  writeFileSync(casePath, JSON.stringify(manifest));
  await assert.rejects(main(f.args), /refusing to score agents on them: toy-add \(not_discriminating\)/);
});

test("claude-code agents run headless with the fixed preamble and no web or MCP tools", () => {
  const command = agentCommand({ id: "x", kind: "claude-code", model: "claude-sonnet-5-5" }, "/tmp/it's.jsonl");
  assert.match(command, /^\{ printf %s 'You are working in a git repository/);
  assert.match(command, /claude -p --model 'claude-sonnet-5-5' --output-format stream-json --verbose/);
  assert.match(command, /--disallowedTools WebFetch WebSearch/);
  assert.match(command, /--strict-mcp-config/);
  assert.match(command, /> '\/tmp\/it'\\''s\.jsonl'$/);
});

test("transcript summary reads turns, cost and the models that answered", () => {
  const transcript = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5-5-20260901" } }),
    "not json",
    JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 7, total_cost_usd: 0.42, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30 } }),
  ].join("\n");
  assert.deepEqual(summarizeTranscript(transcript), {
    finished: true,
    subtype: "success",
    isError: false,
    turns: 7,
    costUsd: 0.42,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    modelsSeen: ["claude-sonnet-5-5-20260901"],
  });
  assert.deepEqual(summarizeTranscript(""), { finished: false, modelsSeen: [] });
});
