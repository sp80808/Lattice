import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import type { FeedItem, ViewState, WorkflowMode } from "../state/types.js";
import { modeColor } from "../theme/icons.js";

interface EventStreamProps {
  feed: FeedItem[];
  view: ViewState;
  workflow: WorkflowMode;
  activePhase?: string;
  columns: number;
  height: number;
}

export const EventStream: React.FC<EventStreamProps> = ({ feed, view, workflow, activePhase, columns, height }) => {
  const [offset, setOffset] = useState(0);
  const width = Math.max(10, columns - 4);
  const lines = feed.flatMap(item => [item.title, item.text].filter((text): text is string => Boolean(text)).flatMap(text =>
    text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").split("\n").flatMap(line => {
      const chars = Array.from(line);
      return Array.from({ length: Math.max(1, Math.ceil(chars.length / width)) }, (_, index) => ({
        text: chars.slice(index * width, (index + 1) * width).join(""),
        color: item.type === "error" ? "red" : item.tone === "success" ? "green" : item.tone === "warning" ? "yellow" : item.type === "task" ? modeColor(workflow) : "gray",
      }));
    })));
  const count = Math.max(1, height - (view === "running" ? 2 : 1));
  const maxOffset = Math.max(0, lines.length - count);
  const end = lines.length - Math.min(offset, maxOffset);
  useEffect(() => setOffset(0), [feed.length]);
  useInput((_input, key) => {
    if (key.pageUp) setOffset(previous => Math.min(maxOffset, previous + count));
    if (key.pageDown) setOffset(previous => Math.max(0, previous - count));
  }, { isActive: view === "idle" || view === "running" });
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {lines.slice(Math.max(0, end - count), end).map((line, index) => <Text key={index} color={line.color} wrap="truncate">{line.text || " "}</Text>)}
      {offset > 0 && <Text dimColor>Earlier activity · PageDown to return</Text>}
      {view === "running" && <Text color={modeColor(workflow)}><Spinner type="dots" /> {activePhase || "Starting workflow"}</Text>}
    </Box>
  );
};
