import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { COMMANDS } from "../commands/registry.js";
import type { WorkflowMode } from "../state/types.js";
import { modeColor } from "../theme/icons.js";

interface PromptBarProps {
  onSubmit: (input: string) => void;
  disabled?: boolean;
  workflow: WorkflowMode;
  columns: number;
  onHeightChange?: (height: number) => void;
}

export const PromptBar: React.FC<PromptBarProps> = ({ onSubmit, disabled = false, workflow, columns, onHeightChange }) => {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const draft = useRef("");
  const pasting = useRef(false);
  const [selection, setSelection] = useState(0);
  const chars = Array.from(value);
  const trimmed = value.trim();
  const suggestions = trimmed.startsWith("/") && !/\s/.test(trimmed)
    ? Object.values(COMMANDS).filter(command => `/${command.name}`.startsWith(trimmed)) : [];
  const replace = (text: string) => { setValue(text); setCursor(Array.from(text).length); };
  const insert = (text: string) => {
    const added = Array.from(text);
    setValue([...chars.slice(0, cursor), ...added, ...chars.slice(cursor)].join(""));
    setCursor(cursor + added.length);
    setHistoryIndex(null);
    setSelection(0);
  };

  useInput((input, key) => {
    if (key.tab) {
      if (!key.shift && suggestions.length) replace(`/${suggestions[selection % suggestions.length]!.name} `);
      return;
    }
    if (key.escape || key.pageUp || key.pageDown || (key.ctrl && input === "c")) return;
    if (input.includes("[200~")) pasting.current = true;
    const pasted = pasting.current;
    if (input.includes("[201~")) pasting.current = false;
    if (key.return) {
      if (pasted || key.shift || key.meta) insert("\n");
      else if (value.endsWith("\\")) replace(value.slice(0, -1) + "\n");
      else if (trimmed) {
        setHistory(previous => [...previous.slice(-99), value]);
        setHistoryIndex(null);
        replace("");
        onSubmit(value.trim());
      }
      return;
    }
    if (key.leftArrow) { setCursor(Math.max(0, cursor - 1)); return; }
    if (key.rightArrow) { setCursor(Math.min(chars.length, cursor + 1)); return; }
    if (key.backspace || key.delete) {
      if (cursor > 0) { setValue([...chars.slice(0, cursor - 1), ...chars.slice(cursor)].join("")); setCursor(cursor - 1); }
      return;
    }
    if (key.upArrow || key.downArrow) {
      const direction = key.upArrow ? -1 : 1;
      if (suggestions.length) setSelection(previous => (previous + direction + suggestions.length) % suggestions.length);
      else if (value.includes("\n")) {
        const before = chars.slice(0, cursor).join("").split("\n");
        const lines = value.split("\n");
        const row = Math.max(0, Math.min(lines.length - 1, before.length - 1 + direction));
        setCursor(Array.from(lines.slice(0, row).join("\n")).length + (row ? 1 : 0) + Math.min(Array.from(before.at(-1)!).length, Array.from(lines[row]!).length));
      } else if (history.length) {
        if (historyIndex === null) draft.current = value;
        const next = Math.max(0, Math.min(history.length, (historyIndex ?? history.length) + direction));
        setHistoryIndex(next === history.length ? null : next);
        replace(next === history.length ? draft.current : history[next]!);
      }
      return;
    }
    if (key.ctrl) {
      if (input === "a") setCursor(0);
      if (input === "e") setCursor(chars.length);
      if (input === "u") replace("");
      return;
    }
    const text = input.replace(/(?:\x1b)?\[(?:200|201)~/g, "").replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\t/g, "  ");
    if (text) insert(text);
  }, { isActive: !disabled });

  const width = Math.max(8, columns - 6);
  const rendered = [...chars.slice(0, cursor), "|", ...chars.slice(cursor)].join("").split("\n").flatMap(line => {
    const text = Array.from(line);
    return Array.from({ length: Math.max(1, Math.ceil(text.length / width)) }, (_, index) => text.slice(index * width, (index + 1) * width).join(""));
  });
  const beforeCursor = chars.slice(0, cursor).join("").split("\n");
  const cursorRow = beforeCursor.slice(0, -1).reduce((rows, line) => rows + Math.max(1, Math.ceil(Array.from(line).length / width)), 0) + Math.floor(Array.from(beforeCursor.at(-1)!).length / width);
  const start = Math.max(0, cursorRow - 2);
  const height = (disabled ? 1 : Math.min(3, rendered.length)) + 1 + (!disabled && suggestions.length ? 1 : 0) + (rendered.length > 3 ? 1 : 0);
  useEffect(() => { onHeightChange?.(height); }, [height, onHeightChange]);
  return (
    <Box flexDirection="column">
      {!disabled && suggestions.length > 0 && <Text wrap="truncate" dimColor>
        Tab complete · Up/Down: {suggestions.map((command, index) => index === selection % suggestions.length ? `[/${command.name}]` : `/${command.name}`).join("  ")}
      </Text>}
      <Box flexDirection="column" borderStyle="single" borderColor={modeColor(workflow)} borderTop={false} borderRight={false} borderBottom={false} paddingLeft={1}>
        {disabled ? <Text dimColor wrap="truncate">Working · Ctrl+C requests cancellation after active worker</Text> : value ? rendered.slice(start, start + 3).map((line, index) => <Text key={start + index} wrap="truncate">{line}</Text>) : <Text color={modeColor(workflow)}>{"> "}<Text dimColor>{workflow.toUpperCase()} task or /help...</Text></Text>}
      </Box>
      <Text dimColor wrap="truncate">Shift+Tab mode · Enter submit · \\ Enter newline · PageUp/Down activity · /help</Text>
      {rendered.length > 3 && <Text dimColor>{rendered.length} draft rows · arrows navigate · Ctrl+A/E start/end</Text>}
    </Box>
  );
};
