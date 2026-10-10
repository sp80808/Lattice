import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { runDoctor, listRuns, getRun, getRunChanges, loadConfig } from "@lattice/service";
import type { FeedItem, DiffState, WorkflowMode } from "../state/types.js";
import { ICONS } from "../theme/icons.js";

export interface CommandContext {
  cwd: string;
  configPath?: string;
  workflow: WorkflowMode;
  setWorkflow: (workflow: WorkflowMode) => void;
  setProject: (path: string) => void;
  runWorkflow: (task: string, workflow: WorkflowMode, files?: string[]) => Promise<void>;
  addFeedItem: (item: Omit<FeedItem, "id" | "timestamp">) => void;
  clearFeed: () => void;
  setDiff: (diff: DiffState | undefined) => void;
  exit: () => void;
}

export interface CommandDefinition {
  name: string;
  description: string;
  usage?: string;
  execute: (args: string[], ctx: CommandContext) => Promise<void>;
}

export const COMMANDS: Record<string, CommandDefinition> = {
  help: {
    name: "help",
    description: "Display slash commands and keyboard shortcuts",
    usage: "/help",
    execute: async (_args, ctx) => {
      const commandLines = Object.values(COMMANDS).map(
        (cmd) => `  /${cmd.name.padEnd(10)} ${cmd.description}`
      );
      const text = [
        "Available Slash Commands:",
        ...commandLines,
        "",
        "Shortcuts & Controls:",
        "  [Enter]     Submit prompt / slash command",
        "  Shift+Tab   Cycle PLAN / BUILD / AUTO (idle only)",
        "  Ctrl+C      Request cancellation / exit when idle",
        "              Active workers finish or reach their timeout first",
        "  Tab         Complete selected slash command",
        "  \\ Enter    Continue a multiline draft (paste stays in the editor)",
        "  Up/Down     Command selection / prompt history",
        "  PageUp/Down Scroll activity or diff",
      ].join("\n");

      ctx.addFeedItem({
        type: "info",
        title: `${ICONS.sparkle} Lattice Help & Commands`,
        text,
      });
    },
  },

  mode: {
    name: "mode", description: "Select PLAN, BUILD or AUTO", usage: "/mode plan|build|auto",
    execute: async (args, ctx) => {
      const mode = args[0];
      if (args.length !== 1 || (mode !== "plan" && mode !== "build" && mode !== "auto")) {
        ctx.addFeedItem({ type: "info", title: `Current mode: ${ctx.workflow.toUpperCase()}`, text: "Usage: /mode plan|build|auto" });
        return;
      }
      ctx.setWorkflow(mode);
    },
  },
  project: {
    name: "project", description: "Inspect or select the target directory", usage: "/project [path]",
    execute: async (args, ctx) => {
      if (!args.length) { ctx.addFeedItem({ type: "info", title: "Target project", text: ctx.cwd }); return; }
      const path = await realpath(resolve(ctx.cwd, args.join(" ")));
      if (!(await stat(path)).isDirectory()) throw new Error("Project must be a directory");
      ctx.setProject(path);
      ctx.addFeedItem({ type: "info", title: "Target project selected", text: path });
    },
  },
  plan: {
    name: "plan", description: "Generate a grounded draft; optionally select sources", usage: "/plan <task> [--file path:start-end]",
    execute: async (args, ctx) => {
      const task: string[] = [], files: string[] = [];
      for (let index = 0; index < args.length; index++) {
        if (args[index] === "--file") {
          const file = args[++index];
          if (!file) throw new Error("--file requires a source selection");
          files.push(file);
        } else task.push(args[index]!);
      }
      if (!task.length) throw new Error("Usage: /plan <task> [--file path:start-end]");
      await ctx.runWorkflow(task.join(" "), "plan", files.length ? files : undefined);
    },
  },

  doctor: {
    name: "doctor",
    description: "Run diagnostic checks for node, git, models, and verifier",
    usage: "/doctor [--offline]",
    execute: async (args, ctx) => {
      const offline = args.includes("--offline");
      ctx.addFeedItem({
        type: "info",
        title: `${ICONS.clock} Running Lattice Doctor...`,
        text: `Inspecting environment in ${ctx.cwd} (offline: ${offline})`,
      });

      try {
        const report = await runDoctor({ cwd: ctx.cwd, configPath: ctx.configPath, network: !offline });
        const lines = report.checks.map((check) => {
          const icon = check.status === "ok" ? ICONS.check : check.status === "warn" ? ICONS.warn : ICONS.cross;
          const statusText = `[${check.status.toUpperCase()}]`.padEnd(8);
          const hint = check.hint ? `\n      ${ICONS.arrowRight} ${check.hint}` : "";
          return `  ${icon} ${check.id.padEnd(12)} ${statusText} ${check.message}${hint}`;
        });

        lines.push("");
        lines.push(report.ok && report.checks.some(check => check.id === "config.auto" && check.status === "ok")
          ? "Coding configuration checked; worker authentication is tested at execution."
          : "Coding readiness requires an auto config, agent, verifier and Git project. Run lattice init in the target directory.");

        ctx.addFeedItem({
          type: "doctor",
          title: `${ICONS.latticeNode} Doctor Report`,
          text: lines.join("\n"),
          data: report,
        });
      } catch (err: unknown) {
        ctx.addFeedItem({
          type: "error",
          title: `${ICONS.cross} Doctor Error`,
          text: err instanceof Error ? err.message : String(err),
        });
      }
    },
  },

  runs: {
    name: "runs",
    description: "List recent execution runs in this repository",
    usage: "/runs [limit]",
    execute: async (args, ctx) => {
      const limit = Number.parseInt(args[0] || "10", 10) || 10;
      try {
        const runs = await listRuns({ cwd: ctx.cwd, limit });
        if (runs.length === 0) {
          ctx.addFeedItem({
            type: "info",
            title: `${ICONS.diamond} Recorded Runs`,
            text: "No runs recorded yet in this workspace. Run a task to create one!",
          });
          return;
        }

        const lines = runs.map((run) => {
          const statusIcon = run.status === "completed" ? ICONS.check : run.status === "failed" ? ICONS.cross : ICONS.warn;
          const id = run.runId.slice(0, 8);
          const time = run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : "-";
          const task = (run.task || "unnamed task").slice(0, 45);
          return `  ${statusIcon} ${id}  [${run.status}]  ${time}  ${task}`;
        });

        ctx.addFeedItem({
          type: "runs",
          title: `${ICONS.diamond} Recent Runs (${runs.length})`,
          text: lines.join("\n"),
          data: runs,
        });
      } catch (err: unknown) {
        ctx.addFeedItem({
          type: "error",
          title: `${ICONS.cross} Failed to list runs`,
          text: err instanceof Error ? err.message : String(err),
        });
      }
    },
  },

  show: {
    name: "show",
    description: "Display details for a specific run ID or latest",
    usage: "/show [id|latest]",
    execute: async (args, ctx) => {
      const id = args[0] || "latest";
      try {
        const detail = await getRun(id, ctx.cwd);
        if (!detail) {
          ctx.addFeedItem({
            type: "error",
            title: `${ICONS.cross} Run Not Found`,
            text: `No run matching '${id}' found in ${ctx.cwd}`,
          });
          return;
        }

        const text = [
          `Run ID:     ${detail.runId}`,
          `Task:       ${detail.task ?? "none"}`,
          `Status:     ${detail.status}`,
          `Evidence:   ${detail.evidence} items collected`,
          `Events:     ${detail.events} total events recorded`,
          `Event Log:  ${detail.logPath}`,
        ].join("\n");

        ctx.addFeedItem({
          type: "output",
          title: `${ICONS.hexagonFilled} Run Details: ${detail.runId.slice(0, 8)}`,
          text,
          data: detail,
        });
      } catch (err: unknown) {
        ctx.addFeedItem({
          type: "error",
          title: `${ICONS.cross} Show Run Error`,
          text: err instanceof Error ? err.message : String(err),
        });
      }
    },
  },

  diff: {
    name: "diff",
    description: "Open the diff viewer for a specific run or patch",
    usage: "/diff [id]",
    execute: async (args, ctx) => {
      const id = args[0] || "latest";
      try {
        const detail = await getRun(id, ctx.cwd);
        const changes = await getRunChanges(id, ctx.cwd);
        const patch = changes.map(change => `# ${change.changedFiles.join(", ")}\n# workspace: ${change.workspace} (${change.retained ? "retained" : "cleaned"})\n${change.diff}`).join("\n");

        if (!patch) {
          ctx.addFeedItem({
            type: "info",
            title: `${ICONS.diamond} Diff Viewer`,
            text: `Run ${id} has no recorded worker patch. Older runs may predate patch recording.`,
          });
          return;
        }

        ctx.setDiff({
          title: `Patch for ${detail.runId.slice(0, 8)}: ${detail.task ?? ""}`,
          diffText: patch,
        });
      } catch (err: unknown) {
        ctx.addFeedItem({
          type: "error",
          title: `${ICONS.cross} Diff Error`,
          text: err instanceof Error ? err.message : String(err),
        });
      }
    },
  },

  config: {
    name: "config",
    description: "Display resolved Lattice configuration",
    usage: "/config",
    execute: async (_args, ctx) => {
      try {
        const loaded = await loadConfig(ctx.cwd, ctx.configPath);
        if (!loaded) {
          ctx.addFeedItem({
            type: "info",
            title: `${ICONS.hexagon} Resolved Configuration`,
            text: "No configuration file found in this repository. Lattice operates in evidence-only bootstrap mode.",
          });
          return;
        }

        const decisionModel = loaded.config.models?.decision
          ? ("model" in loaded.config.models.decision
              ? loaded.config.models.decision.model
              : loaded.config.models.decision.provider)
          : "default";
        const verifierText = loaded.config.verify
          ? ("command" in loaded.config.verify
              ? loaded.config.verify.command
              : `tessera: ${loaded.config.verify.tessera.file}`)
          : "none";

        const text = [
          `Path:     ${loaded.path}`,
          `Autonomy: ${loaded.config.autonomy?.mode ?? "supervised"}`,
          `Models:`,
          `  generator: ${loaded.config.models?.generator?.model ?? loaded.config.model?.model ?? (loaded.config.models?.generatorPool?.length ? "routed pool" : "none")}`,
          `Agent:      ${loaded.config.agent?.preset ?? "none"}`,
          `  decision:  ${decisionModel}`,
          `Verifier:   ${verifierText}`,
        ].join("\n");

        ctx.addFeedItem({
          type: "output",
          title: `${ICONS.hexagon} Resolved Configuration`,
          text,
          data: loaded,
        });
      } catch (err: unknown) {
        ctx.addFeedItem({
          type: "error",
          title: `${ICONS.cross} Config Error`,
          text: err instanceof Error ? err.message : String(err),
        });
      }
    },
  },

  clear: {
    name: "clear",
    description: "Clear the active TUI feed items",
    usage: "/clear",
    execute: async (_args, ctx) => {
      ctx.clearFeed();
    },
  },

  exit: {
    name: "exit",
    description: "Exit Lattice TUI",
    usage: "/exit",
    execute: async (_args, ctx) => {
      ctx.exit();
    },
  },
};

export async function dispatchSlashCommand(
  rawInput: string,
  ctx: CommandContext
): Promise<boolean> {
  const trimmed = rawInput.trim();
  if (!trimmed.startsWith("/")) return false;

  const [cmdWithSlash, ...args] = trimmed.split(/\s+/);
  const commandName = cmdWithSlash!.slice(1).toLowerCase();

  const command = COMMANDS[commandName];
  if (!command) {
    ctx.addFeedItem({
      type: "error",
      title: `${ICONS.warn} Unknown Command`,
      text: `Unknown slash command '/${commandName}'. Type /help to see available commands.`,
    });
    return true;
  }

  await command.execute(args, ctx);
  return true;
}
