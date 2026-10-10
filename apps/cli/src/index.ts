#!/usr/bin/env node
import { LATTICE_VERSION, LatticeServiceError } from "@lattice/service";
import {
  benchCommand,
  configCommand,
  doctorCommand,
  initCommand,
  mcpCommand,
  mineCommand,
  policySimCommand,
  planCommand,
  runCommand,
  runsCommand,
  serveCommand,
  showCommand,
  statsCommand,
  UsageError,
} from "./commands.js";

const HELP = `Lattice ${LATTICE_VERSION} — generate less, choose cheaply, verify everything.

Usage:
  lattice "your coding task"            shorthand for \`lattice run\`
  lattice <command> [options]

Tasks:
  run <task...>        run a task          [--config path] [--observe] [--json]
  plan <task...>       create a source-grounded implementation plan
                         --file path[:start-end]... [--config path] [--lattice-dir path] [--json]
  runs                 list recorded runs  [-n limit] [--json]
  show [id|latest]     show one run        [--events] [-f|--follow] [--json]

Setup:
  init                 write .lattice/config.json
                         [--preset ollama|vllm|openai-compatible|observe]
                         [--model m] [--base-url url] [--api-key-env VAR]
                         [--agent qwen-code|opencode] [--verify "cmd args"] [--no-verify]
                         [--autonomy autopilot|supervised|manual] [--force] [--print]
  doctor               check node, git, config, models, agent and verifier [--offline] [--json]
  config               print the resolved config [--config path] [--json]

Benchmarks:
  bench [suite-dir]    compare decision strategies on fixture tasks (default: benchmarks/basic)
                         [-s first,random,cheapest-first,oracle,configured] [-n trials] [--seed N]
                         [--rounds N] [--task id ...] [--config path] [-o report.json] [--json]
                         [-j concurrency] [--shard i/n] [--baseline report.json]   exit 1 on regression
                         [--check]   verify fixtures fail as shipped and pass with their solution

Integrations:
  serve                HTTP daemon on 127.0.0.1 [--port 4774] [--token t] [--origin url ...]
  mcp                  MCP server over stdio (for Claude Code, Codex, Cursor, ...)

Replay analytics:
  stats [--json] [run-file-or-directory ...]
  mine [--json] [--out dir] [--rules N] [--tiles N] [run-path ...]
  policy-sim candidate.json [--against run-path ...] [--holdout 0.2] [--json]

Global:
  -C, --cwd <dir>      operate on another project directory
  -h, --help           show this help
  -v, --version        print version

Config discovery: --config, $LATTICE_CONFIG, .lattice/config.json, lattice.config.json
Autonomy modes: autopilot | supervised | manual
Docs: docs/cli.md`;

const COMMANDS: Record<string, (args: string[]) => Promise<number>> = {
  run: runCommand,
  plan: planCommand,
  bench: benchCommand,
  init: initCommand,
  doctor: doctorCommand,
  runs: runsCommand,
  show: showCommand,
  config: configCommand,
  serve: serveCommand,
  mcp: mcpCommand,
  stats: statsCommand,
  mine: mineCommand,
  "policy-sim": policySimCommand,
};

/** Hoist leading `-C dir` / `--cwd dir` / `--cwd=dir` so they may precede the command. */
function hoistGlobals(argv: string[]): { globals: string[]; remaining: string[] } {
  const globals: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index]!;
    if (arg === "-C" || arg === "--cwd") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError(`${arg} requires a directory`);
      globals.push("--cwd", value);
      index += 2;
    } else if (arg.startsWith("--cwd=")) {
      globals.push(arg);
      index += 1;
    } else {
      break;
    }
  }
  return { globals, remaining: argv.slice(index) };
}

async function main(argv: string[]): Promise<number> {
  const { globals, remaining } = hoistGlobals(argv);
  const [first, ...tail] = remaining;
  const rest = [...globals, ...tail];
  if (first === undefined) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      try {
        // @ts-ignore dynamic import resolved when @lattice/tui workspace is present
        const { runTui } = await import("@lattice/tui");
        return await runTui(globals);
      } catch (err: any) {
        if (err?.code !== "ERR_MODULE_NOT_FOUND" && !err?.message?.includes("@lattice/tui")) {
          throw err;
        }
      }
    }
    console.log(HELP);
    return 0;
  }
  if (first === "help" || first === "-h" || first === "--help") {
    console.log(HELP);
    return 0;
  }
  if (first === "-v" || first === "--version" || first === "version") {
    console.log(LATTICE_VERSION);
    return 0;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const command = COMMANDS[first];
  // Anything that is not a command is a task: `lattice "fix the tests"`.
  return command ? command(rest) : runCommand([...globals, ...remaining]);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`lattice: ${error.message}`);
    console.error("run `lattice --help` for usage");
    process.exitCode = 2;
  } else if (error instanceof LatticeServiceError) {
    console.error(`lattice: ${error.message}`);
    process.exitCode = 1;
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
