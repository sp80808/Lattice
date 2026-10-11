#!/usr/bin/env node
// Run a frozen self-dogfood case (issue #41) and record the outcome as a run log.
//
//   node scripts/dogfood-run.mjs <case-id|manifest.json> --source <repo> [mode] [options]
//
// Modes:
//   --calibrate        (default) run acceptance at base_sha and at gold_fix_sha and
//                      report whether the acceptance commands tell them apart.
//   --patch <file>     apply a candidate patch to base_sha and run acceptance.
//   --agent <command>  run a coding agent on base_sha, capture its diff, then run
//                      acceptance. The agent gets the task statement on stdin and in
//                      LATTICE_DOGFOOD_TASK, and nothing from the manifest's reference.
//
// Options:
//   --out <dir>          run log directory (default: .lattice/runs)
//   --timeout-ms <n>     per command timeout (default: 900000)
//   --keep               keep the workspaces instead of deleting them
//   --json               print the result as JSON
//
// Every workspace is a history-less snapshot of one commit (git archive), so the
// agent cannot reach the gold fix or any later commit through git, and paths in
// leakage_guard.exclude_paths_from_context are removed before anything runs.
// Files in acceptance.held_out_from_gold are copied from the gold fix after the
// patch or agent has run, so held-out tests judge the change without being visible.
// A setup failure, a patch that does not apply, or a leak makes the result
// inconclusive; it never counts as a pass or as a discriminating failure.
//
// Exit codes: 0 verified/discriminating, 1 failed/not discriminating, 2 inconclusive or usage.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_TAIL = 4096;
const DEFAULT_TIMEOUT_MS = 900_000;
// Fixed identity and date so the snapshot commit id depends only on the tree.
const SNAPSHOT_ENV = {
  GIT_AUTHOR_NAME: "lattice-dogfood",
  GIT_AUTHOR_EMAIL: "dogfood@lattice.invalid",
  GIT_COMMITTER_NAME: "lattice-dogfood",
  GIT_COMMITTER_EMAIL: "dogfood@lattice.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

export function loadCase(ref, dogfoodRoot = join(root, "dogfood")) {
  let path;
  if (ref.endsWith(".json")) {
    path = isAbsolute(ref) ? ref : resolve(process.cwd(), ref);
  } else {
    const index = JSON.parse(readFileSync(join(dogfoodRoot, "index.json"), "utf8"));
    path = index.cases
      .map((rel) => join(dogfoodRoot, rel))
      .find((file) => JSON.parse(readFileSync(file, "utf8")).id === ref);
    if (!path) throw new Error(`no dogfood case with id ${JSON.stringify(ref)}`);
  }
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.schema !== "lattice.dogfood.case/v0") {
    throw new Error(`${path}: unsupported schema ${manifest.schema}`);
  }
  return { path, manifest };
}

function git(cwd, args, options = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 30, ...options });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function hasCommit(repo, sha) {
  return spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: repo }).status === 0;
}

/**
 * Materialise `sha` from `source` as a fresh single-commit repository and apply
 * the case's leakage guard. Returns the workspace and what the guard checked.
 */
export function snapshot(source, sha, manifest, parent) {
  const dir = mkdtempSync(join(parent, `${manifest.id}-${sha.slice(0, 8)}-`));
  const archive = spawnSync("git", ["archive", "--format=tar", sha], {
    cwd: source,
    maxBuffer: 1 << 30,
  });
  if (archive.status !== 0) {
    throw new Error(`git archive ${sha} failed: ${archive.stderr.toString().trim()}`);
  }
  const untar = spawnSync("tar", ["-x", "-C", dir], { input: archive.stdout });
  if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr.toString().trim()}`);

  const guard = manifest.leakage_guard;
  const removed = [];
  for (const rel of guard.exclude_paths_from_context) {
    const target = resolve(dir, rel);
    if (!target.startsWith(dir + "/")) throw new Error(`excluded path escapes workspace: ${rel}`);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      removed.push(rel);
    }
  }

  const env = { ...process.env, ...SNAPSHOT_ENV };
  git(dir, ["init", "-q", "-b", "dogfood"], { env });
  git(dir, ["add", "-A", "-f"], { env });
  git(dir, ["commit", "-q", "--allow-empty", "--no-gpg-sign", "--no-verify", "-m", `dogfood ${manifest.id} @ ${sha}`], { env });
  const head = git(dir, ["rev-parse", "HEAD"]).trim();

  const commits = git(dir, ["rev-list", "--all"]).trim().split("\n").filter(Boolean);
  const leakedCommits = guard.exclude_commits_from_context.filter((excluded) => hasCommit(dir, excluded));
  const leakedPaths = guard.exclude_paths_from_context.filter((rel) => existsSync(resolve(dir, rel)));
  const leaks = [
    ...(commits.length !== 1 ? [`workspace has ${commits.length} commits, expected 1`] : []),
    ...leakedCommits.map((sha) => `excluded commit ${sha} reachable in workspace`),
    ...leakedPaths.map((rel) => `excluded path ${rel} present in workspace`),
  ];
  return { dir, head, removed, leaks };
}

/** Run one shell command with a timeout, killing its whole process group on expiry. */
export function runCommand(command, cwd, { timeoutMs = DEFAULT_TIMEOUT_MS, input, env } = {}) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn("bash", ["-c", command], {
      cwd,
      env: env ?? process.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const keep = (text, chunk) => (text + chunk).slice(-OUTPUT_TAIL);
    child.stdout.on("data", (chunk) => (stdout = keep(stdout, chunk)));
    child.stderr.on("data", (chunk) => (stderr = keep(stderr, chunk)));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({
        command,
        exitCode: code,
        signal,
        timedOut,
        passed: code === 0 && !timedOut,
        durationMs: Date.now() - started,
        stdoutTail: stdout,
        stderrTail: stderr,
      });
    });
  });
}

function evidenceId(parts) {
  return `ev_${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16)}`;
}

function commandEvidence(manifest, phase, sha, result) {
  const status = result.timedOut ? "timed out" : `exit ${result.exitCode ?? result.signal}`;
  return {
    id: evidenceId([manifest.id, manifest.version, phase, sha, result.command]),
    kind: "command",
    verified: result.passed,
    source: result.command,
    summary: `${phase} @ ${sha.slice(0, 12)}: ${status} in ${result.durationMs}ms`,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Snapshot `sha`, optionally change it (patch or agent), run setup and acceptance.
 * `status` is "passed", "failed" (an acceptance command failed) or "inconclusive".
 */
async function runPhase(phase, sha, ctx, change) {
  const { manifest, source, parent, timeoutMs } = ctx;
  const ws = snapshot(source, sha, manifest, parent);
  const phaseResult = {
    phase,
    sha,
    workspace: ws.dir,
    snapshotCommit: ws.head,
    removedPaths: ws.removed,
    leaks: ws.leaks,
    setup: [],
    acceptance: [],
    evidence: [],
  };
  const finish = (status, reason) => Object.assign(phaseResult, { status, reason });
  if (ws.leaks.length) return finish("inconclusive", `leakage guard: ${ws.leaks.join("; ")}`);

  if (change) {
    const changed = await change(ws.dir, phaseResult);
    if (changed) return finish("inconclusive", changed);
  }

  // Held-out checks come from the gold fix and land only after any change, so
  // the agent never sees them but acceptance does.
  for (const rel of manifest.acceptance.held_out_from_gold ?? []) {
    const target = resolve(ws.dir, rel);
    if (!target.startsWith(ws.dir + "/")) throw new Error(`held-out path escapes workspace: ${rel}`);
    const blob = spawnSync("git", ["show", `${manifest.reference.gold_fix_sha}:${rel}`], { cwd: source, maxBuffer: 1 << 30 });
    if (blob.status !== 0) return finish("inconclusive", `held-out file ${rel} missing at gold fix`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, blob.stdout);
    (phaseResult.heldOut ??= []).push(rel);
  }

  for (const command of manifest.acceptance.setup ?? []) {
    const result = await runCommand(command, ws.dir, { timeoutMs });
    phaseResult.setup.push(result);
    if (!result.passed) return finish("inconclusive", `setup failed: ${command}`);
  }
  for (const command of manifest.acceptance.commands) {
    const result = await runCommand(command, ws.dir, { timeoutMs });
    phaseResult.acceptance.push(result);
    phaseResult.evidence.push(commandEvidence(manifest, phase, sha, result));
  }
  const failed = phaseResult.acceptance.filter((result) => !result.passed);
  return failed.length
    ? finish("failed", `${failed.length}/${phaseResult.acceptance.length} acceptance commands failed`)
    : finish("passed", "all acceptance commands passed");
}

function applyPatch(patchPath) {
  const patch = readFileSync(patchPath, "utf8");
  return async (dir, phaseResult) => {
    phaseResult.patchSha256 = createHash("sha256").update(patch).digest("hex");
    const applied = spawnSync("git", ["apply", "--index", "-"], { cwd: dir, input: patch, encoding: "utf8" });
    if (applied.status !== 0) return `patch does not apply: ${applied.stderr.trim()}`;
    phaseResult.changedFiles = git(dir, ["diff", "--cached", "--name-only"]).trim().split("\n").filter(Boolean);
    return undefined;
  };
}

function runAgent(agentCommand, manifest, timeoutMs) {
  return async (dir, phaseResult) => {
    // Only the task-facing fields reach the agent; reference/provenance never do.
    const env = {
      ...process.env,
      LATTICE_DOGFOOD_TASK: manifest.task_statement,
      LATTICE_DOGFOOD_CASE: manifest.id,
      LATTICE_DOGFOOD_ALLOWED_TOOLS: manifest.allowed_tools.join(","),
    };
    const result = await runCommand(agentCommand, dir, { timeoutMs, input: manifest.task_statement, env });
    phaseResult.agent = result;
    git(dir, ["add", "-A"]);
    const diff = git(dir, ["diff", "--cached", "--binary"]);
    phaseResult.patch = diff;
    phaseResult.patchSha256 = createHash("sha256").update(diff).digest("hex");
    phaseResult.changedFiles = git(dir, ["diff", "--cached", "--name-only"]).trim().split("\n").filter(Boolean);
    if (result.timedOut) return "agent timed out";
    return undefined;
  };
}

/** Judge calibration: base must fail, and gold must pass when the manifest says so. */
export function judgeCalibration(manifest, base, gold) {
  if (base.status === "inconclusive" || gold.status === "inconclusive") {
    return { verdict: "inconclusive", reason: [base, gold].filter((p) => p.status === "inconclusive").map((p) => `${p.phase}: ${p.reason}`).join("; ") };
  }
  const commands = manifest.acceptance.commands.map((command, i) => ({
    command,
    base: base.acceptance[i]?.passed ? "pass" : "fail",
    gold: gold.acceptance[i]?.passed ? "pass" : "fail",
  }));
  for (const row of commands) row.discriminates = row.base === "fail" && row.gold === "pass";
  const problems = [];
  if (manifest.acceptance.must_fail_on_broken_base && base.status !== "failed") {
    problems.push("acceptance passes at the broken base");
  }
  if (manifest.acceptance.must_pass_on_fixed_sha && gold.status !== "passed") {
    problems.push("acceptance fails at the gold fix");
  }
  return problems.length
    ? { verdict: "not_discriminating", reason: problems.join("; "), commands }
    : { verdict: "discriminating", reason: "base fails and gold fix passes", commands };
}

function writeRunLog(outDir, runId, manifest, mode, phases, outcome) {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${runId}.jsonl`);
  let seq = 0;
  const event = (type, payload) => JSON.stringify({ seq: seq++, runId, at: new Date().toISOString(), type, payload });
  const lines = [
    event("run.started", {
      task: `dogfood ${manifest.id} v${manifest.version} (${mode})`,
      dogfood: { caseId: manifest.id, caseVersion: manifest.version, taskClass: manifest.task_class, repository: manifest.repository, mode },
    }),
    event("tap.created", { repo: { revision: manifest.base_sha } }),
    ...phases.map((phase, round) =>
      event("tool.completed", {
        tool: "experiment",
        round,
        outcome: {
          candidateId: phase.phase,
          status: phase.status === "passed" ? "success" : phase.status,
          terminal: true,
          summary: phase.reason,
          evidence: phase.evidence,
        },
        dogfood: {
          sha: phase.sha,
          snapshotCommit: phase.snapshotCommit,
          removedPaths: phase.removedPaths,
          leaks: phase.leaks,
          patchSha256: phase.patchSha256,
          changedFiles: phase.changedFiles,
          heldOut: phase.heldOut,
          agent: phase.agent,
          setup: phase.setup,
          acceptance: phase.acceptance,
        },
      }),
    ),
    event(outcome.ok ? "run.completed" : "run.failed", { verdict: outcome.verdict, reason: outcome.reason, commands: outcome.commands }),
  ];
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

export async function runCase({ caseRef, source, mode = "calibrate", patch, agent, outDir, timeoutMs = DEFAULT_TIMEOUT_MS, keep = false, dogfoodRoot }) {
  const { manifest } = loadCase(caseRef, dogfoodRoot);
  const repo = resolve(source);
  const needsGold = mode === "calibrate" || (manifest.acceptance.held_out_from_gold ?? []).length > 0;
  for (const sha of [manifest.base_sha, ...(needsGold ? [manifest.reference.gold_fix_sha] : [])]) {
    if (!hasCommit(repo, sha)) throw new Error(`${repo} does not contain ${sha}; fetch ${manifest.repository} first`);
  }
  const parent = mkdtempSync(join(tmpdir(), "lattice-dogfood-"));
  const ctx = { manifest, source: repo, parent, timeoutMs };
  const runId = `dogfood-${manifest.id}-${mode}-${randomUUID().slice(0, 8)}`;
  const phases = [];
  let outcome;
  try {
    if (mode === "calibrate") {
      phases.push(await runPhase("base", manifest.base_sha, ctx));
      phases.push(await runPhase("gold", manifest.reference.gold_fix_sha, ctx));
      const judged = judgeCalibration(manifest, phases[0], phases[1]);
      outcome = { ...judged, ok: judged.verdict === "discriminating" };
    } else {
      const change = mode === "patch" ? applyPatch(resolve(patch)) : runAgent(agent, manifest, timeoutMs);
      const phase = await runPhase(mode, manifest.base_sha, ctx, change);
      phases.push(phase);
      const verdict = phase.status === "passed" ? "verified" : phase.status === "failed" ? "failed" : "inconclusive";
      outcome = { verdict, reason: phase.reason, ok: verdict === "verified" };
    }
  } finally {
    if (!keep) rmSync(parent, { recursive: true, force: true });
  }
  const logPath = writeRunLog(outDir ?? join(process.cwd(), ".lattice", "runs"), runId, manifest, mode, phases, outcome);
  return { runId, caseId: manifest.id, mode, ...outcome, phases, logPath, workspaces: keep ? parent : undefined };
}

function parseArgs(argv) {
  const opts = { mode: "calibrate" };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === "--source") opts.source = value();
    else if (arg === "--calibrate") opts.mode = "calibrate";
    else if (arg === "--patch") Object.assign(opts, { mode: "patch", patch: value() });
    else if (arg === "--agent") Object.assign(opts, { mode: "agent", agent: value() });
    else if (arg === "--out") opts.outDir = resolve(value());
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(value());
    else if (arg === "--keep") opts.keep = true;
    else if (arg === "--json") opts.json = true;
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else rest.push(arg);
  }
  if (rest.length !== 1 || !opts.source) {
    throw new Error("usage: dogfood-run.mjs <case-id|manifest.json> --source <repo> [--calibrate | --patch <file> | --agent <cmd>] [--out dir] [--timeout-ms n] [--keep] [--json]");
  }
  if (!(opts.timeoutMs === undefined || opts.timeoutMs > 0)) throw new Error("--timeout-ms must be a positive number");
  return { ...opts, caseRef: rest[0] };
}

function report(result) {
  console.log(`${result.caseId} (${result.mode}): ${result.verdict} — ${result.reason}`);
  for (const phase of result.phases) {
    console.log(`  ${phase.phase} @ ${phase.sha.slice(0, 12)}: ${phase.status}`);
    for (const run of [...phase.setup, ...phase.acceptance]) {
      const status = run.timedOut ? "timeout" : run.passed ? "pass" : `exit ${run.exitCode ?? run.signal}`;
      console.log(`    ${status.padEnd(8)} ${run.command} (${run.durationMs}ms)`);
    }
  }
  for (const row of result.commands ?? []) {
    console.log(`  ${row.discriminates ? "discriminates" : "does not discriminate"}: ${row.command} (base ${row.base}, gold ${row.gold})`);
  }
  console.log(`  run log: ${result.logPath}`);
  if (result.workspaces) console.log(`  workspaces kept in ${result.workspaces}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  try {
    const result = await runCase(opts);
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else report(result);
    process.exit(result.ok ? 0 : result.verdict === "inconclusive" ? 2 : 1);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(2);
  }
}
