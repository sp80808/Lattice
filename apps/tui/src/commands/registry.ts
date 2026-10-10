import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  runDoctor,
  listRuns,
  getRun,
  getRunEvents,
  getRunChanges,
  loadConfig,
  checkModelReadiness,
  writeConfig,
  listAvailableModels,
  selectPreferredModel,
} from "@lattice/service";
import { registerTargetsFromLiveOllama, targetSupportsRole } from "@lattice/providers";
import { renderVerification, verificationRecords } from "@lattice/tessera";
import {
  ArtifactStore,
  ColabClient,
  schedule,
  type ColabSession,
  type WorkloadKind,
} from "@lattice/colab";
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
  /** Re-read the config and re-validate readiness without restarting the TUI. */
  reloadConfig: () => Promise<void>;
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

        const records = (await getRunEvents(detail.runId, ctx.cwd))
          .filter(event => event.type === "tool.completed")
          .flatMap(event => verificationRecords(event.payload));
        const text = [
          `Run ID:     ${detail.runId}`,
          `Task:       ${detail.task ?? "none"}`,
          `Status:     ${detail.status}`,
          `Evidence:   ${detail.evidence} items collected`,
          `Events:     ${detail.events} total events recorded`,
          `Event Log:  ${detail.logPath}`,
          ...(records.length ? [
            `Tessera evidence: ${records.length} check(s), showing the latest ${Math.min(5, records.length)}`,
            ...records.slice(-5).map(renderVerification),
          ] : []),
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

  models: {
    name: "models",
    description: "Inspect available models and switch the generator",
    usage: "/models [model-id]",
    execute: async (args, ctx) => {
      const requested = args.join(" ").trim();
      const loaded = await loadConfig(ctx.cwd, ctx.configPath);
      if (!loaded) {
        ctx.addFeedItem({
          type: "info",
          title: `${ICONS.hexagon} No configuration`,
          text: "No Lattice config found in this project. Run lattice init first, then /models.",
        });
        return;
      }

      const active = loaded.config.models?.generator ?? loaded.config.model;
      const baseUrl = active?.baseUrl;
      if (!baseUrl) {
        ctx.addFeedItem({
          type: "error",
          title: `${ICONS.cross} No model endpoint configured`,
          text: "The config has no model or models.generator entry. Add one before selecting a model.",
        });
        return;
      }

      // Real provider discovery — never a hardcoded list.
      const available = await listAvailableModels(baseUrl, {});
      const readiness = await checkModelReadiness(loaded.config, {});

      if (requested) {
        if (!available.length) {
          ctx.addFeedItem({
            type: "error",
            title: `${ICONS.cross} Cannot verify that model`,
            text: `${baseUrl} did not publish a model list, so '${requested}' cannot be validated.\nInstall it first, then re-run /models.`,
          });
          return;
        }
        if (!available.some((id) => id === requested || id.startsWith(`${requested}:`))) {
          ctx.addFeedItem({
            type: "error",
            title: `${ICONS.cross} Model not available`,
            text:
              `'${requested}' is not served by ${baseUrl}.\n` +
              `available: ${available.join(", ")}\n` +
              `/models alone lists them; nothing was changed.`,
          });
          return;
        }

        const next = {
          ...loaded.config,
          model: { ...active, model: requested },
          models: loaded.config.models ? { ...loaded.config.models } : undefined,
        };
        const path = await writeConfig(next, { cwd: ctx.cwd, path: loaded.path, force: true });
        await ctx.reloadConfig();
        ctx.addFeedItem({
          type: "info",
          title: `${ICONS.check} Generator model set`,
          text: `${path} now uses '${requested}'.\nRe-validated without restarting.`,
        });
        return;
      }

      const current = readiness.roles.find((role) => role.role !== "decision") ?? readiness.roles[0];
      const lines = available.length
        ? available.map((id) => {
            const isCurrent = id === (current?.modelId ?? "");
            const caps = readiness.roles.find((r) => r.modelId === id)?.capabilities ?? [];
            const note = caps.length ? `  (${caps.slice(0, 3).join(", ")})` : "";
            return `  ${isCurrent ? `${ICONS.pointer} ` : "  "}${id}${isCurrent ? "  ← current" : ""}${note}`;
          })
        : [`  ${baseUrl} did not publish a model list`];

      lines.push("", `Role readiness:`, ...readiness.roles.map((role) => `  ${role.status === "ok" ? ICONS.check : ICONS.warn} ${role.role.padEnd(10)} ${role.message.split("\n")[0]}`));

      // Execution-target registry: the exact transport each model is reachable on.
      const registry = await registerTargetsFromLiveOllama(baseUrl, fetch, {
        roles: ["decision", "generator", "coding-worker", "verifier", "benchmark-executor"],
      });
      const targets = registry.list();
      const unique = new Map<string, (typeof targets)[number]>();
      for (const target of targets) unique.set(`${target.modelId}::${target.transport}`, target);
      if (unique.size) {
        lines.push("", "Execution targets:");
        for (const target of unique.values()) {
          const usable = targetSupportsRole(target, target.role) ? ICONS.check : ICONS.warn;
          lines.push(
            `  ${usable} ${target.modelId.padEnd(22)} ${target.role.padEnd(19)} via ${target.transport}`,
          );
        }
      }
      for (const role of ["decision", "generator"] as const) {
        try {
          const chosen = registry.select(role);
          lines.push(`  ${ICONS.check} ${role} dispatches to ${chosen.modelId} over ${chosen.transport}`);
        } catch (error) {
          lines.push(`  ${ICONS.cross} ${role} has no eligible target: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      lines.push("", "/models <id> selects a listed model and re-validates immediately.");
      lines.push("/colab inspects remote batch sessions and recovered artifacts.");

      ctx.addFeedItem({
        type: "info",
        title: `${ICONS.hexagon} Models at ${baseUrl} (${available.length})`,
        text: lines.join("\n"),
        data: { available, readiness, targets: [...unique.values()] },
      });
    },
  },

  colab: {
    name: "colab",
    description: "Inspect live Colab sessions, usage and recovered artifacts",
    usage: "/colab",
    execute: async (_args, ctx) => {
      ctx.addFeedItem({
        type: "info",
        title: `${ICONS.clock} Inspecting Colab…`,
        text: "Discovering live sessions through the official colab CLI.",
      });
      try {
        const client = new ColabClient();
        const lines: string[] = [];
        let sessions: ColabSession[] = [];
        let usage;
        try {
          sessions = client.sessions();
        } catch (error) {
          lines.push(`${ICONS.cross} colab CLI unavailable: ${error instanceof Error ? error.message : String(error)}`);
          lines.push("  Colab is an optional remote batch backend; local execution is unaffected.");
        }
        try {
          usage = client.usage();
        } catch {
          /* usage is advisory; a missing balance must not fail the command */
        }

        if (sessions.length) {
          lines.push(`Live sessions (${sessions.length}):`);
          for (const session of sessions) {
            const status = client.status(session.name);
            const state = status.stale ? "stale" : session.accelerator.toUpperCase();
            lines.push(`  ${ICONS.bullet} ${session.name.padEnd(20)} ${session.acceleratorLabel.padEnd(6)} ${state}`);
          }
        } else {
          lines.push(`${ICONS.bullet} No live Colab sessions.`);
        }

        if (usage) {
          lines.push(
            "",
            `Compute units: balance ${usage.balanceUnits}, rate ${usage.usageRatePerHour}/hr, active assignments ${usage.activeAssignments}.`,
          );
        }

        // Scheduling policy preview against the live session set.
        const probes: Array<[WorkloadKind, string]> = [
          ["test", "compilers, tests and verification"],
          ["decision-inference", "cheap decision inference"],
          ["training", "GPU-only training"],
        ];
        lines.push("", "Scheduler preview:");
        for (const [kind, label] of probes) {
          const decision = schedule({ kind, accelerationBenefit: kind === "training" ? 1 : 0 }, {
            sessions,
            usage,
            computeUnitBudget: Number(process.env.LATTICE_CU_BUDGET ?? "") || undefined,
            approvedForPaidResources: process.env.LATTICE_COLAB_APPROVED === "1",
          });
          lines.push(
            `  ${decision.requiresApproval ? ICONS.warn : ICONS.check} ${kind.padEnd(20)} → ${decision.backend.padEnd(14)} ${label}` +
              `${decision.reuseSession ? ` (reuse ${decision.reuseSession})` : ""}`,
          );
        }

        const store = new ArtifactStore({ root: join(ctx.cwd, ".colab-artifacts") });
        const records = store.allRecords();
        if (records.length) {
          lines.push("", `Recovered experiments (${records.length}):`);
          for (const record of records) {
            lines.push(`  ${ICONS.bullet} ${record.session}/${record.kind}: ${record.outcome} — ${record.reason}`);
          }
        } else {
          lines.push("", "No recovered artifacts recorded in this project yet.");
        }
        lines.push("", "New paid Colab compute always requires explicit approval; nothing is provisioned implicitly.");

        ctx.addFeedItem({
          type: "info",
          title: `${ICONS.hexagon} Colab remote batch`,
          text: lines.join("\n"),
          data: { sessions, usage },
        });
      } catch (error) {
        ctx.addFeedItem({
          type: "error",
          title: `${ICONS.cross} Colab inspection failed`,
          text: error instanceof Error ? error.message : String(error),
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
