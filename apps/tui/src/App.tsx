import React, { useState, useEffect, useRef } from "react";
import { resolve } from "node:path";
import { Box, useApp, useInput, useStdout } from "ink";
import { executeWorkflow, loadConfig, getRunChanges, LatticeServiceError, detectVerifyCommand, buildInitConfig, writeConfig, listAvailableModels, INIT_PRESET_DEFAULTS } from "@lattice/service";
import type { RunEvent } from "@lattice/protocol";
import { Header } from "./components/Header.js";
import { EventStream } from "./components/EventStream.js";
import { PromptBar } from "./components/PromptBar.js";
import { DecisionReviewModal } from "./components/DecisionReviewModal.js";
import { DiffViewer } from "./components/DiffViewer.js";
import { dispatchSlashCommand, type CommandContext } from "./commands/registry.js";
import type { FeedItem, ViewState, WorkflowMode, ReviewState, DiffState, DecisionReviewer, ReviewOutcome } from "./state/types.js";
import { nextWorkflow } from "./theme/icons.js";
import { describeEvent } from "./state/events.js";

interface AppProps { globals?: string[] }

export const App: React.FC<AppProps> = ({ globals = [] }) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [dimensions, setDimensions] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  const [cwd, setCwd] = useState(() => {
    let path = process.cwd();
    for (let i = 0; i < globals.length; i++) {
      if (globals[i] === "--cwd" || globals[i] === "-C") path = globals[++i] || path;
      else if (globals[i]?.startsWith("--cwd=")) path = globals[i]!.slice(6);
    }
    return resolve(path);
  });
  const [configPath, setConfigPath] = useState<string>();
  const [readiness, setReadiness] = useState("Checking configuration...");
  const [view, setView] = useState<ViewState>("idle");  const [workflow, setWorkflow] = useState<WorkflowMode>("plan");
  const [feed, setFeed] = useState<FeedItem[]>([{ id: "welcome", type: "info", title: "Plan, build and verify with Lattice", text: "PLAN reads sources. BUILD reviews decisions. AUTO runs bounded isolated workers. /project selects the target; /doctor checks setup.", timestamp: new Date() }]);
  const [activePhase, setActivePhase] = useState<string>();
  const [composerHeight, setComposerHeight] = useState(2);
  const [review, setReview] = useState<ReviewState>();
  const [diff, setDiff] = useState<DiffState>();
  const busy = useRef(false);
  const controller = useRef<AbortController>();
  const pendingReview = useRef<ReviewState>();
  const mounted = useRef(true);
  const sequence = useRef(0);
  const bufferedEvents = useRef<FeedItem[]>([]);
  const eventTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const resize = () => setDimensions({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", resize);
    return () => { stdout.off("resize", resize); mounted.current = false; clearTimeout(eventTimer.current); controller.current?.abort(); pendingReview.current?.resolve({ action: "stop" }); };
  }, [stdout]);
  useEffect(() => {
    let current = true;
    setConfigPath(undefined);
    loadConfig(cwd).then(async loaded => {
      if (!current) return;
      if (loaded) {
        setConfigPath(loaded.path);
        const generator = loaded.config.models?.generator?.model ?? loaded.config.model?.model ?? (loaded.config.models?.generatorPool?.length ? "routed model pool" : "missing generator");
        const agent = loaded.config.agent?.preset ?? "missing agent";
        setReadiness(`${generator} · ${agent} · ${loaded.config.verify ? "verifier configured" : "missing verifier"} · /doctor`);
        return;
      }
      await autoInitialize(cwd);
    }).then(() => {}, error => { if (current) setReadiness(`CONFIG ERROR · ${error.message}`); });
    return () => { current = false; };
  }, [cwd]);

  /** Auto-init: write .lattice/config.json on launch so /plan, /build and /auto work immediately. */
  const autoInitialize = async (target: string) => {
    setReadiness("initializing configuration...");
    try {
      const verify = await detectVerifyCommand(target);
      const baseUrl = INIT_PRESET_DEFAULTS.ollama.baseUrl;
      const availableModels = baseUrl ? await listAvailableModels(baseUrl) : [];
      const plan = buildInitConfig({ preset: "ollama", verify, availableModels });
      const path = await writeConfig(plan.config, { cwd: target });
      setConfigPath(path);
      const generator = plan.config.model?.model ?? "missing generator";
      setReadiness(`${generator} · ${plan.config.agent?.preset ?? "missing agent"} · ${plan.config.verify ? "verifier configured" : "missing verifier"} · /doctor`);
      addFeedItem({ type: "info", title: "Auto-initialized configuration", text: `wrote ${path} (mode=${plan.config.mode}, model=${generator})` });
      for (const warning of plan.warnings) {
        addFeedItem({ type: "info", tone: "warning", title: "Init warning", text: warning });
      }
    } catch (error) {
      setReadiness(`SETUP REQUIRED · ${error instanceof Error ? error.message : String(error)} · /doctor`);
    }
  };

  const flushEvents = () => {
    clearTimeout(eventTimer.current);
    eventTimer.current = undefined;
    const items = bufferedEvents.current;
    bufferedEvents.current = [];
    if (mounted.current && items.length) setFeed(previous => [...previous, ...items].slice(-200));
  };
  const addFeedItem = (item: Omit<FeedItem, "id" | "timestamp">) => {
    if (!mounted.current) return;
    const entry = { ...item, id: `item-${++sequence.current}`, timestamp: new Date() };
    if (item.type === "event") {
      bufferedEvents.current = [...bufferedEvents.current.slice(-199), entry];
      eventTimer.current ??= setTimeout(flushEvents, 50);
    } else {
      flushEvents();
      setFeed(previous => [...previous.slice(-199), entry]);
    }
  };
  const switchWorkflow = (next: WorkflowMode) => {
    if (controller.current || view === "reviewing") {
      addFeedItem({ type: "info", tone: "warning", title: "Mode locked during execution", text: "Wait for this workflow to finish before switching." });
    } else setWorkflow(next);
  };
  useInput((input, key) => {
    if (key.tab && key.shift) {
      if (busy.current) addFeedItem({ type: "info", tone: "warning", title: "Mode locked while working" });
      else switchWorkflow(nextWorkflow(workflow));
    }
    if (key.ctrl && input === "c") {
      if (controller.current) {
        controller.current.abort(new Error("Cancellation requested"));
        pendingReview.current?.resolve({ action: "stop" });
        addFeedItem({ type: "info", tone: "warning", title: "Cancellation requested", text: "The active model/worker finishes or reaches its configured timeout before the loop stops." });
      } else if (!busy.current) exit();
    }
  });

  const reviewer: DecisionReviewer = request => new Promise<ReviewOutcome>(settle => {
    if (!mounted.current || controller.current?.signal.aborted) return settle({ action: "stop" });
    setView("reviewing");
    let settled = false;
    const state: ReviewState = { request, resolve: outcome => {
      if (settled) return;
      settled = true;
      pendingReview.current = undefined;
      if (mounted.current) { setView("running"); setReview(undefined); }
      settle(outcome);
    } };
    pendingReview.current = state;
    setReview(state);
  });
  const onEvent = (event: RunEvent) => {
    const { phase, text } = describeEvent(event);
    if (mounted.current) setActivePhase(phase);
    addFeedItem({ type: "event", title: `${event.at.slice(11, 19)} ${phase} · ${event.runId.slice(0, 8)}`, text });
  };
  const runWorkflow = async (input: string, selected: WorkflowMode, files?: string[]) => {
    setView("running");
    setActivePhase("Checking workflow setup");
    controller.current = new AbortController();
    addFeedItem({ type: "task", title: `${selected.toUpperCase()} · ${input}` });
    try {
      const result = await executeWorkflow(input, { cwd, configPath, workflow: selected, files, reviewer, onEvent, signal: controller.current.signal });
      const cancelled = controller.current.signal.aborted;
      const patches = selected === "plan" ? [] : await getRunChanges(result.runId, cwd);
      const verified = !cancelled && result.search?.status === "solved" && patches.some(patch => patch.changedFiles.length > 0);
      const status = cancelled ? "CANCELLED" : selected === "plan" ? "PLANNED" : verified ? "VERIFIED PATCH" : result.search?.status === "blocked" ? "BLOCKED" : "NEEDS REVIEW";
      const patchInfo = patches.map(patch => `${patch.changedFiles.join(", ") || "No changes"} · ${patch.retained ? `retained at ${patch.workspace}` : "worktree cleaned; patch recorded"}`).join("\n");
      addFeedItem({ type: "result", tone: verified ? "success" : selected === "plan" ? "muted" : "warning", title: `${status} (${result.runId.slice(0, 8)})`, text: `${result.summary}\nEvidence: ${result.tap.evidence.length}\n${patchInfo}${selected === "plan" ? "\nDraft only; no implementation or checks ran." : "\nIsolated changes require review; /diff latest inspects recorded patches."}` });
    } catch (error) {
      addFeedItem({ type: error instanceof LatticeServiceError ? "info" : "error", tone: "warning", title: error instanceof LatticeServiceError ? "BLOCKED · setup required" : controller.current.signal.aborted ? "CANCELLED" : "FAILED", text: error instanceof Error ? error.message : String(error) });
    } finally {
      controller.current = undefined;
      if (mounted.current) { setView("idle"); setActivePhase(undefined); }
    }
  };
  const commandContext: CommandContext = {
    cwd, configPath, workflow, addFeedItem, runWorkflow, setWorkflow: switchWorkflow,
    setProject: path => { setCwd(path); setFeed([]); },
    clearFeed: () => setFeed([]),
    setDiff: state => { setDiff(state); setView(state ? "diff" : "idle"); },
    exit: () => exit(),
  };
  const handleSubmit = async (input: string) => {
    if (busy.current) return;
    busy.current = true;
    try {
      if (!await dispatchSlashCommand(input, commandContext)) await runWorkflow(input, workflow);
    } catch (error) {
      addFeedItem({ type: "error", title: "Command failed", text: error instanceof Error ? error.message : String(error) });
    } finally { busy.current = false; }
  };
  const { columns, rows } = dimensions;
  const showLogo = feed.length === 1 && feed[0]?.id === "welcome" && columns >= 100 && rows >= 30;
  const activityHeight = Math.max(2, rows - 6 - composerHeight - (showLogo ? 7 : 0));
  return (
    <Box flexDirection="column" paddingX={1} width={columns}>
      <Header cwd={cwd} readiness={readiness} workflow={workflow} view={view} columns={columns} rows={rows} showLogo={showLogo} />
      {view !== "diff" && view !== "reviewing" && <EventStream feed={feed} view={view} workflow={workflow} activePhase={activePhase} columns={columns} height={activityHeight} />}
      {view === "reviewing" && review && <DecisionReviewModal request={review.request} onResolve={review.resolve} height={activityHeight} />}
      {view === "diff" && diff && <DiffViewer title={diff.title} diffText={diff.diffText} height={activityHeight} onClose={() => commandContext.setDiff(undefined)} />}
      <PromptBar onSubmit={handleSubmit} workflow={workflow} columns={columns} disabled={view !== "idle"} onHeightChange={setComposerHeight} />
    </Box>
  );
};
