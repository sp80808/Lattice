import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface DiffViewerProps { title: string; diffText: string; onClose: () => void; height: number }

export const DiffViewer: React.FC<DiffViewerProps> = ({ title, diffText, onClose, height }) => {
  const [offset, setOffset] = useState(0);
  const lines = diffText.split("\n");
  const count = Math.max(1, height - 2);
  const maxOffset = Math.max(0, lines.length - count);
  const start = Math.min(offset, maxOffset);
  useInput((input, key) => {
    if (key.escape || input === "q") onClose();
    if (key.downArrow || key.pageDown) setOffset(previous => Math.min(maxOffset, previous + (key.pageDown ? count : 1)));
    if (key.upArrow || key.pageUp) setOffset(previous => Math.max(0, previous - (key.pageUp ? count : 1)));
  });
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Text color="cyan" bold wrap="truncate">{title}</Text>
      {lines.slice(start, start + count).map((line, index) => <Text key={start + index} wrap="truncate" color={
        line.startsWith("+") ? "green" : line.startsWith("-") ? "red" : line.startsWith("@@") ? "cyan" : line.startsWith("diff ") || line.startsWith("#") ? "yellow" : "gray"
      }>{line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "") || " "}</Text>)}
      <Text dimColor>{start + 1}-{Math.min(lines.length, start + count)} / {lines.length} · Up/Down · PageUp/Down · Esc/q close</Text>
    </Box>
  );
};
