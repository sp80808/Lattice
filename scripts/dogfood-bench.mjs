#!/usr/bin/env node
// Run the pinned dogfood benchmark (issue #41): every agent in a suite on every
// case, a fixed number of attempts each, one run at a time, then write a report.
//
//   node scripts/dogfood-bench.mjs [suite.json] [options]
//
// Options:
//   --source <owner/repo>=<path>   clone holding a case's base and gold commits
//                                  (default: sp80808/Lattice is this checkout,
//                                  sp80808/Tessera is ../Tessera)
//   --out <dir>                    results directory (default: .lattice/dogfood-bench/<suite-id>)
//   --agents a,b  --cases a,b      run a subset (the report marks it as partial)
//   --attempts <n>                 override the suite's attempt count (also partial)
//   --skip-calibration             trust the suite's case list instead of re-checking
//                                  that each case's acceptance tells base from gold
//   --report-only                  rebuild REPORT.md from runs.jsonl without running
//
// Runs are appended to <out>/runs.jsonl as they finish, and a rerun skips every
// (agent, case, attempt) already there, so an interrupted benchmark resumes.
// Each run goes through scripts/dogfood-run.mjs in --agent mode: a history-less
// snapshot of the base commit, the agent, then setup and acceptance with the gold
// fix's held-out tests copied in afterwards.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCase, runCase } from "./dogfood-run.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Fixed text put in front of every task statement, so prompts are identical across agents.
export const PROMPT_PREAMBLE =
  "You are working in a git repository (the current directory). Fix the problem described below by editing files here. " +
  "Do not commit, and do not look outside this directory. When you are done, stop.\n\nTask:\n";

export function loadSuite(path) {
  const suite = JSON.parse(readFileSync(path, "utf8"));
  if (suite.schema !== "lattice.dogfood.bench/v1") throw new Error(`${path}: unsupported schema ${suite.schema}`);
  const ids = new Set();
  for (const agent of suite.agents) {
    if (ids.has(agent.id)) throw new Error(`${path}: duplicate agent ${agent.id}`);
    ids.add(agent.id);
    if (agent.kind === "claude-code" && !agent.model) throw new Error(`${path}: agent ${agent.id} needs a model`);
    if (agent.kind === "control" && !agent.command) throw new Error(`${path}: agent ${agent.id} needs a command`);
    if (!["claude-code", "control", "command"].includes(agent.kind)) throw new Error(`${path}: agent ${agent.id} has unknown kind ${agent.kind}`);
  }
  if (!(suite.attempts > 0)) throw new Error(`${path}: attempts must be positive`);
  return suite;
}

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

/** The shell command dogfood-run.mjs runs in the workspace for one agent attempt. */
export function agentCommand(agent, transcriptPath) {
  if (agent.kind !== "claude-code") return agent.command;
  // The task arrives on stdin. No MCP servers, no web tools, no user settings or
  // saved sessions, so the run depends only on the model, the CLI and the workspace.
  return [
    `{ printf %s ${quote(PROMPT_PREAMBLE)}; cat; } |`,
    "claude -p",
    `--model ${quote(agent.model)}`,
    "--output-format stream-json --verbose",
    "--allowedTools Bash Read Edit Write Glob Grep",
    "--disallowedTools WebFetch WebSearch",
    "--strict-mcp-config --setting-sources project --no-session-persistence",
    `> ${quote(transcriptPath)}`,
  ].join(" ");
}

/** Pull turns, cost, tokens and the models actually used from a stream-json transcript. */
export function summarizeTranscript(text) {
  let result;
  const modelsSeen = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "assistant" && event.message?.model) modelsSeen.add(event.message.model);
    if (event.type === "result") result = event;
  }
  if (!result) return { finished: false, modelsSeen: [...modelsSeen] };
  return {
    finished: true,
    subtype: result.subtype,
    isError: Boolean(result.is_error),
    turns: result.num_turns,
    costUsd: result.total_cost_usd,
    inputTokens: result.usage?.input_tokens,
    outputTokens: result.usage?.output_tokens,
    cacheReadTokens: result.usage?.cache_read_input_tokens,
    modelsSeen: [...modelsSeen],
  };
}

/**
 * Strings an agent could only know by reaching past its snapshot: the source
 * clones (full history), the gold fix commit and PR, or the case manifests.
 */
export function contaminationMarkers(manifest, sourcePaths) {
  const gold = manifest.reference.gold_fix_sha;
  return [
    ...sourcePaths,
    gold.slice(0, 10),
    ...(manifest.reference.gold_pr ? [manifest.reference.gold_pr.replace(/^https?:\/\//, "")] : []),
    "dogfood/cases/",
  ];
}

export function findContamination(text, markers) {
  return markers.filter((marker) => marker && text.includes(marker));
}

function parseArgs(argv) {
  const opts = { sources: {} };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    const list = () => value().split(",").map((s) => s.trim()).filter(Boolean);
    if (arg === "--source") {
      const [repo, path] = value().split("=");
      if (!repo || !path) throw new Error("--source takes <owner/repo>=<path>");
      opts.sources[repo] = resolve(path);
    } else if (arg === "--out") opts.out = resolve(value());
    else if (arg === "--agents") opts.agents = list();
    else if (arg === "--cases") opts.cases = list();
    else if (arg === "--attempts") opts.attempts = Number(value());
    else if (arg === "--skip-calibration") opts.skipCalibration = true;
    else if (arg === "--report-only") opts.reportOnly = true;
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else rest.push(arg);
  }
  if (rest.length > 1) throw new Error("usage: dogfood-bench.mjs [suite.json] [--source owner/repo=path] [--out dir] [--agents a,b] [--cases a,b] [--attempts n] [--skip-calibration] [--report-only]");
  opts.suitePath = resolve(rest[0] ?? join(root, "dogfood", "bench", "v1.json"));
  return opts;
}

function readRuns(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function claudeVersion() {
  const result = spawnSync("claude", ["--version"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function headSha(path) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");
const money = (n) => (n === undefined || n === null ? "n/a" : `$${n.toFixed(2)}`);
const minutes = (ms) => `${(ms / 60000).toFixed(1)}m`;

/** Aggregate per agent and per (agent, case). A contaminated run never counts as solved. */
export function aggregate(runs) {
  const byAgent = new Map();
  for (const run of runs) {
    const solved = run.verdict === "verified" && run.contamination.length === 0;
    const agent = byAgent.get(run.agent) ?? { agent: run.agent, runs: 0, solved: 0, inconclusive: 0, contaminated: 0, costUsd: 0, costKnown: true, durationMs: 0, cases: new Map() };
    agent.runs++;
    agent.solved += solved ? 1 : 0;
    agent.inconclusive += run.verdict === "inconclusive" ? 1 : 0;
    agent.contaminated += run.contamination.length ? 1 : 0;
    if (typeof run.agentStats?.costUsd === "number") agent.costUsd += run.agentStats.costUsd;
    else if (run.kind === "claude-code") agent.costKnown = false;
    agent.durationMs += run.agentDurationMs ?? 0;
    const perCase = agent.cases.get(run.case) ?? { attempts: 0, solved: 0, outcomes: [] };
    perCase.attempts++;
    perCase.solved += solved ? 1 : 0;
    perCase.outcomes[run.attempt - 1] = solved ? "pass" : run.contamination.length ? "contaminated" : run.verdict === "inconclusive" ? "inconclusive" : "fail";
    agent.cases.set(run.case, perCase);
    byAgent.set(run.agent, agent);
  }
  return byAgent;
}

export function renderReport({ suite, meta, calibration, runs, partial }) {
  const byAgent = aggregate(runs);
  const caseIds = [...new Set(runs.map((run) => run.case))];
  const lines = [];
  lines.push(`# ${suite.id} results`, "");
  if (partial) lines.push("> **Partial run** (agents, cases or attempts were filtered). Do not quote these as headline numbers.", "");
  lines.push(`A case counts as solved when every acceptance command passes, with the gold fix's held-out tests copied in after the agent finished, and the agent's transcript shows no sign of reaching the gold fix. Inconclusive runs (setup failed, agent timed out) count as unsolved.`, "");
  lines.push("## Solve rate", "");
  lines.push(`| Agent | Solved | ${caseIds.map((id) => `\`${id}\``).join(" | ")} | Agent time | Cost |`);
  lines.push(`| --- | --- | ${caseIds.map(() => "---").join(" | ")} | --- | --- |`);
  for (const agent of byAgent.values()) {
    const cells = caseIds.map((id) => {
      const c = agent.cases.get(id);
      return c ? `${c.solved}/${c.attempts} (${c.outcomes.map((o) => (o === "pass" ? "✓" : o === "fail" ? "✗" : o === "inconclusive" ? "?" : "!")).join("")})` : "–";
    });
    const cost = agent.costKnown && suite.agents.find((a) => a.id === agent.agent)?.kind === "claude-code" ? money(agent.costUsd) : agent.costKnown ? "–" : "incomplete";
    lines.push(`| \`${agent.agent}\` | ${agent.solved}/${agent.runs} (${pct(agent.solved, agent.runs)}) | ${cells.join(" | ")} | ${minutes(agent.durationMs)} | ${cost} |`);
  }
  lines.push("", "✓ solved, ✗ acceptance failed, ? inconclusive, ! contaminated. Cost is what Claude Code reports, at API list prices.", "");

  if (calibration.length) {
    lines.push("## Calibration", "");
    lines.push("| Case | Verdict | Reason |", "| --- | --- | --- |");
    for (const c of calibration) lines.push(`| \`${c.case}\` | ${c.verdict} | ${c.reason} |`);
    lines.push("");
  }
  if (suite.excluded_cases?.length) {
    lines.push("## Cases left out", "");
    for (const c of suite.excluded_cases) lines.push(`- \`${c.case}\`: ${c.reason}`);
    lines.push("");
  }

  lines.push("## Runs", "");
  lines.push("| Agent | Case | Attempt | Verdict | Acceptance | Turns | Cost | Agent time | Files changed |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const run of runs) {
    const verdict = run.contamination.length ? `contaminated (${run.contamination.join(", ")})` : run.verdict;
    const acceptance = run.acceptance.map((a) => (a.passed ? "pass" : a.timedOut ? "timeout" : `exit ${a.exitCode}`)).join(", ") || run.reason;
    lines.push(`| \`${run.agent}\` | \`${run.case}\` | ${run.attempt} | ${verdict} | ${acceptance} | ${run.agentStats?.turns ?? "–"} | ${money(run.agentStats?.costUsd)} | ${minutes(run.agentDurationMs ?? 0)} | ${run.changedFiles?.length ?? 0} |`);
  }
  lines.push("");

  lines.push("## Pinned inputs", "");
  lines.push(`- Suite: \`${meta.suitePath}\` (sha256 \`${meta.suiteSha256.slice(0, 16)}\`)`);
  lines.push(`- Attempts per agent and case: ${meta.attempts}; timeout per command: ${minutes(suite.timeout_ms)}`);
  for (const c of meta.cases) lines.push(`- \`${c.id}\` v${c.version}: ${c.repository} @ \`${c.base_sha.slice(0, 12)}\`, held out: ${c.heldOut.join(", ") || "none"}`);
  for (const a of suite.agents) lines.push(`- \`${a.id}\`: ${a.kind === "claude-code" ? `Claude Code, model \`${a.model}\`` : `\`${a.command}\``}`);
  const versions = [...new Set(runs.map((run) => run.claudeVersion).filter(Boolean))];
  if (versions.length) lines.push(`- Claude Code CLI: ${versions.join(", ")}`);
  const models = [...new Set(runs.flatMap((run) => run.agentStats?.modelsSeen ?? []))];
  if (models.length) lines.push(`- Models seen in transcripts: ${models.map((m) => `\`${m}\``).join(", ")}`);
  lines.push(`- Harness: Lattice @ \`${(meta.latticeSha ?? "unknown").slice(0, 12)}\``, "");
  lines.push("## Rerun", "", "```bash", meta.rerun, "```", "");
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const suite = loadSuite(opts.suitePath);
  const suiteText = readFileSync(opts.suitePath, "utf8");
  const sources = { "sp80808/Lattice": root, "sp80808/Tessera": resolve(root, "..", "Tessera"), ...opts.sources };
  const out = opts.out ?? join(root, ".lattice", "dogfood-bench", suite.id);
  mkdirSync(out, { recursive: true });
  const runsPath = join(out, "runs.jsonl");

  // A suite names cases by id, or by manifest path relative to the suite file.
  const allCases = suite.cases.map((ref) => {
    const caseRef = ref.endsWith(".json") ? resolve(dirname(opts.suitePath), ref) : ref;
    return { caseRef, manifest: loadCase(caseRef).manifest };
  });
  const agents = suite.agents.filter((a) => !opts.agents || opts.agents.includes(a.id));
  const selectedCases = allCases.filter(({ manifest }) => !opts.cases || opts.cases.includes(manifest.id));
  const caseIds = selectedCases.map(({ manifest }) => manifest.id);
  const caseRefs = new Map(selectedCases.map(({ caseRef, manifest }) => [manifest.id, caseRef]));
  const cases = selectedCases.map(({ manifest }) => manifest);
  const attempts = opts.attempts ?? suite.attempts;
  for (const id of opts.agents ?? []) if (!suite.agents.some((a) => a.id === id)) throw new Error(`no agent ${id} in suite`);
  for (const id of opts.cases ?? []) if (!allCases.some(({ manifest }) => manifest.id === id)) throw new Error(`no case ${id} in suite`);
  const partial = Boolean(opts.agents || opts.cases || opts.attempts);
  for (const manifest of cases) {
    if (!sources[manifest.repository]) throw new Error(`no --source for ${manifest.repository}`);
  }
  const sourcePaths = [...new Set(Object.values(sources))];

  const calibrationPath = join(out, "calibration.json");
  let calibration = existsSync(calibrationPath) ? JSON.parse(readFileSync(calibrationPath, "utf8")) : [];
  const runOne = !opts.reportOnly;
  if (runOne && !opts.skipCalibration) {
    for (const manifest of cases) {
      if (calibration.some((c) => c.case === manifest.id && c.version === manifest.version)) continue;
      console.log(`calibrating ${manifest.id}…`);
      const result = await runCase({ caseRef: caseRefs.get(manifest.id), source: sources[manifest.repository], mode: "calibrate", outDir: join(out, "logs"), timeoutMs: suite.timeout_ms });
      calibration.push({ case: manifest.id, version: manifest.version, verdict: result.verdict, reason: result.reason, logPath: result.logPath });
      writeFileSync(calibrationPath, JSON.stringify(calibration, null, 2) + "\n");
      console.log(`  ${result.verdict}: ${result.reason}`);
    }
    const bad = calibration.filter((c) => caseIds.includes(c.case) && c.verdict !== "discriminating");
    if (bad.length) throw new Error(`cases do not discriminate, refusing to score agents on them: ${bad.map((c) => `${c.case} (${c.verdict})`).join(", ")}`);
  }

  const done = readRuns(runsPath);
  const key = (agent, caseId, attempt) => `${agent}\u0000${caseId}\u0000${attempt}`;
  const have = new Set(done.map((run) => key(run.agent, run.case, run.attempt)));
  const version = agents.some((a) => a.kind === "claude-code") ? claudeVersion() : null;
  if (runOne && agents.some((a) => a.kind === "claude-code") && !version) throw new Error("claude CLI not found on PATH");

  if (runOne) {
    // Attempt-major order, so a stopped benchmark still has comparable coverage across agents.
    for (let attempt = 1; attempt <= attempts; attempt++) {
      for (const manifest of cases) {
        for (const agent of agents) {
          if (have.has(key(agent.id, manifest.id, attempt))) continue;
          const transcriptPath = join(out, "transcripts", `${agent.id}--${manifest.id}--${attempt}.jsonl`);
          mkdirSync(dirname(transcriptPath), { recursive: true });
          writeFileSync(transcriptPath, "");
          console.log(`${agent.id} on ${manifest.id}, attempt ${attempt}/${attempts}…`);
          const started = Date.now();
          const result = await runCase({
            caseRef: caseRefs.get(manifest.id),
            source: sources[manifest.repository],
            mode: "agent",
            agent: agentCommand(agent, transcriptPath),
            outDir: join(out, "logs"),
            timeoutMs: suite.timeout_ms,
          });
          const phase = result.phases[0] ?? {};
          const transcript = readFileSync(transcriptPath, "utf8");
          // Keep the agent's diff so a "solved" run can be audited for gamed tests.
          const patchPath = join(out, "patches", `${agent.id}--${manifest.id}--${attempt}.patch`);
          mkdirSync(dirname(patchPath), { recursive: true });
          writeFileSync(patchPath, phase.patch ?? "");
          const run = {
            agent: agent.id,
            kind: agent.kind,
            model: agent.model,
            case: manifest.id,
            caseVersion: manifest.version,
            attempt,
            verdict: result.verdict,
            reason: result.reason,
            acceptance: (phase.acceptance ?? []).map(({ command, exitCode, timedOut, passed, durationMs }) => ({ command, exitCode, timedOut, passed, durationMs })),
            changedFiles: phase.changedFiles ?? [],
            patchSha256: phase.patchSha256,
            agentExitCode: phase.agent?.exitCode,
            agentDurationMs: phase.agent?.durationMs,
            agentStats: agent.kind === "claude-code" ? summarizeTranscript(transcript) : undefined,
            contamination: findContamination([transcript, phase.agent?.stdoutTail, phase.agent?.stderrTail].join("\n"), contaminationMarkers(manifest, sourcePaths)),
            claudeVersion: agent.kind === "claude-code" ? version : undefined,
            runLog: result.logPath,
            transcript: transcriptPath,
            patch: patchPath,
            wallMs: Date.now() - started,
            finishedAt: new Date().toISOString(),
          };
          appendFileSync(runsPath, JSON.stringify(run) + "\n");
          done.push(run);
          const flag = run.contamination.length ? ` CONTAMINATED: ${run.contamination.join(", ")}` : "";
          console.log(`  ${run.verdict} (${run.reason})${flag}`);
        }
      }
    }
  }

  const selected = done.filter((run) => agents.some((a) => a.id === run.agent) && caseIds.includes(run.case) && run.attempt <= attempts);
  const rerunArgs = [
    "npm run dogfood:bench --",
    ...(opts.suitePath !== join(root, "dogfood", "bench", "v1.json") ? [opts.suitePath] : []),
    ...Object.entries(opts.sources).map(([repo, path]) => `--source ${repo}=${path}`),
  ];
  const report = renderReport({
    suite,
    meta: {
      suitePath: opts.suitePath.replace(root + "/", ""),
      suiteSha256: (await import("node:crypto")).createHash("sha256").update(suiteText).digest("hex"),
      attempts,
      latticeSha: headSha(root),
      cases: cases.map((m) => ({ id: m.id, version: m.version, repository: m.repository, base_sha: m.base_sha, heldOut: m.acceptance.held_out_from_gold ?? [] })),
      rerun: rerunArgs.join(" "),
    },
    calibration: calibration.filter((c) => caseIds.includes(c.case)),
    runs: selected,
    partial,
  });
  writeFileSync(join(out, "REPORT.md"), report);
  console.log(`\nreport: ${join(out, "REPORT.md")}`);
  return { out, runs: selected };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(2);
  });
}
