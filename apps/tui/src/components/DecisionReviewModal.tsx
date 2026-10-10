import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { ReviewRequest, ReviewOutcome } from "../state/types.js";

interface DecisionReviewModalProps { request: ReviewRequest; onResolve: (outcome: ReviewOutcome) => void; height: number }

export const DecisionReviewModal: React.FC<DecisionReviewModalProps> = ({ request, onResolve, height }) => {
  const [refining, setRefining] = useState(false);
  const [refineText, setRefineText] = useState("");
  const [selection, setSelection] = useState<number | null>(null);
  useInput((input, key) => {
    if (key.escape) {
      if (refining) setRefining(false);
      else onResolve({ action: "stop" });
      return;
    }
    if (refining || key.ctrl || key.tab) return;
    if (input.toLowerCase() === "a") { onResolve({ action: "approve" }); return; }
    if (input.toLowerCase() === "s") { onResolve({ action: "stop" }); return; }
    if (input.toLowerCase() === "r") { setRefining(true); return; }
    if (key.upArrow || key.downArrow) {
      setSelection(previous => ((previous ?? (key.downArrow ? -1 : 1)) + (key.downArrow ? 1 : -1) + request.frame.choices.length) % request.frame.choices.length);
      return;
    }
    const number = /^\d$/.test(input) ? Number(input) - 1 : -1;
    const index = key.return ? selection : number;
    const choice = index === null ? undefined : request.frame.choices[index];
    if (choice) onResolve({ action: "replace", selected: [choice.id], note: "User selected a candidate in the TUI" });
  });
  const count = Math.max(1, height - 6);
  const start = Math.max(0, (selection ?? 0) - count + 1);
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Text color="yellow" bold>Decision review · Round {request.round}</Text>
      <Text wrap="truncate">{request.frame.question}</Text>
      <Text wrap="truncate" dimColor>{request.reasons.join("; ")}</Text>
      {request.frame.choices.slice(start, start + count).map((choice, index) => <Text key={choice.id} color={selection === start + index ? "cyan" : "white"} wrap="truncate">
        {selection === start + index ? ">" : " "} {start + index + 1}. {choice.label} {request.decision.selected.includes(choice.id) ? "[model pick]" : ""}
      </Text>)}
      {refining ? <Box><Text color="cyan">Refine: </Text><TextInput value={refineText} onChange={setRefineText} onSubmit={value => onResolve({ action: "refine", note: value.trim() || undefined })} /></Box> : <Text dimColor wrap="truncate">a approve model · arrows + Enter pick · r refine · Esc/s stop</Text>}
      <Text dimColor wrap="truncate">BUILD reviews candidate decisions; worker tool permissions use project config.</Text>
    </Box>
  );
};
