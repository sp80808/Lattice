import React, { useState, useEffect } from "react";
import { Box, useApp } from "ink";
import { executeTask, loadConfig, type ExecuteTaskOptions } from "@lattice/service";
import { Header } from "./components/Header.js";
import { EventStream } from "./components/EventStream.js";
import { PromptBar } from "./components/PromptBar.js";
import { DecisionReviewModal } from "./components/DecisionReviewModal.js";
import { DiffViewer } from "./components/DiffViewer.js";
import { dispatchSlashCommand, type CommandContext } from "./commands/registry.js";
import type { FeedItem, TuiMode, ReviewState, DiffState, DecisionReviewer, ReviewOutcome } from "./state/types.js";
import { ICONS } from "./theme/icons.js";

interface AppProps {
  globals?: string[];
}

export const App: React.FC<AppProps> = ({ globals = [] }) => {
  const { exit } = useApp();

  let initialCwd = process.cwd();
  for (let i = 0; i < globals.length; i++) {
    if (globals[i] === "--cwd" || globals[i] === "-C") {
      initialCwd = globals[i + 1] || initialCwd;
    } else if (globals[i]?.startsWith("--cwd=")) {
      initialCwd = globals[i]!.split("=")[1] || initialCwd;
    }
  }

  const [cwd] = useState(initialCwd);
  const [configPath, setConfigPath] = useState<string | undefined>();
  const [mode, setMode] = useState<TuiMode>("idle");
  const [feed, setFeed] = useState<FeedItem[]>([
    {
      id: "welcome",
      type: "info",
      title: `${ICONS.sparkle} Welcome to Lattice Interactive Terminal`,
      text: "Type any coding task to execute with evidence and model search, or type /help for commands.",
      timestamp: new Date(),
    },
  ]);
  const [activeTask, setActiveTask] = useState<string | undefined>();
  const [activePhase, setActivePhase] = useState<string | undefined>();
  const [review, setReview] = useState<ReviewState | undefined>();
  const [diff, setDiff] = useState<DiffState | undefined>();

  useEffect(() => {
    loadConfig(cwd)
      .then((loaded) => {
        if (loaded?.path) setConfigPath(loaded.path);
      })
      .catch(() => {});
  }, [cwd]);

  const addFeedItem = (item: Omit<FeedItem, "id" | "timestamp">) => {
    const newItem: FeedItem = {
      ...item,
      id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date(),
    };
    setFeed((prev) => [...prev, newItem]);
  };

  const commandContext: CommandContext = {
    cwd,
    configPath,
    addFeedItem,
    clearFeed: () => setFeed([]),
    setDiff: (diffState) => {
      if (diffState) {
        setDiff(diffState);
        setMode("diff");
      } else {
        setDiff(undefined);
        setMode("idle");
      }
    },
    exit: () => exit(),
  };

  const reviewer: DecisionReviewer = async (request) => {
    return new Promise<ReviewOutcome>((resolve) => {
      setMode("reviewing");
      setReview({
        request,
        resolve: (outcome) => {
          setMode("running");
          setReview(undefined);
          resolve(outcome);
        },
      });
    });
  };

  const handleSubmit = async (input: string) => {
    const isSlash = await dispatchSlashCommand(input, commandContext);
    if (isSlash) return;

    // Execute as task
    setMode("running");
    setActiveTask(input);
    setActivePhase("Initializing task execution...");
    addFeedItem({
      type: "task",
      title: `${ICONS.pointer} Task: ${input}`,
    });

    try {
      const outcome = await executeTask(input, {
        cwd,
        configPath,
        reviewer,
      });

      const { result } = outcome;
      addFeedItem({
        type: "result",
        title: `${ICONS.check} Task Finished (${result.runId.slice(0, 8)})`,
        text: `${result.summary}\nEvidence: ${result.tap.evidence.length} items collected | Mode: ${outcome.runtimeMode}`,
      });
    } catch (err: unknown) {
      addFeedItem({
        type: "error",
        title: `${ICONS.cross} Task Failed`,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setMode("idle");
      setActiveTask(undefined);
      setActivePhase(undefined);
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Header cwd={cwd} configPath={configPath} mode={mode} />

      <EventStream
        feed={feed}
        mode={mode}
        activeTask={activeTask}
        activePhase={activePhase}
      />

      {mode === "reviewing" && review && (
        <DecisionReviewModal
          request={review.request}
          onResolve={review.resolve}
        />
      )}

      {mode === "diff" && diff && (
        <DiffViewer
          title={diff.title}
          diffText={diff.diffText}
          onClose={() => {
            setDiff(undefined);
            setMode("idle");
          }}
        />
      )}

      {mode !== "reviewing" && mode !== "diff" && (
        <PromptBar onSubmit={handleSubmit} disabled={mode === "running"} />
      )}
    </Box>
  );
};
