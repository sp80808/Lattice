import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { ICONS } from "../theme/icons.js";

const SLASH_COMMANDS = [
  { cmd: "/doctor", desc: "Check node, git, models, agent and verifier" },
  { cmd: "/runs", desc: "List recorded runs in this project" },
  { cmd: "/show", desc: "Show details for a specific run ID or latest" },
  { cmd: "/diff", desc: "View file diff or candidate patch" },
  { cmd: "/config", desc: "Show resolved configuration" },
  { cmd: "/clear", desc: "Clear session feed" },
  { cmd: "/help", desc: "Show available commands and usage guide" },
  { cmd: "/exit", desc: "Exit Lattice TUI" },
];

interface PromptBarProps {
  onSubmit: (input: string) => void;
  disabled?: boolean;
}

export const PromptBar: React.FC<PromptBarProps> = ({ onSubmit, disabled = false }) => {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  const trimmed = value.trim();
  const isSlash = trimmed.startsWith("/");
  const suggestions = isSlash
    ? SLASH_COMMANDS.filter((c) => c.cmd.startsWith(trimmed.split(" ")[0] || "/"))
    : [];

  const handleSubmit = (submittedValue: string) => {
    const text = submittedValue.trim();
    if (!text) return;
    setHistory((prev) => [...prev, text]);
    setHistoryIndex(null);
    setValue("");
    onSubmit(text);
  };

  if (disabled) {
    return (
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="gray">{ICONS.pointer} Task in progress... Press Ctrl+C to stop.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {suggestions.length > 0 && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          marginBottom={1}
        >
          <Text color="gray" dimColor>
            Slash commands:
          </Text>
          {suggestions.slice(0, 5).map((s) => (
            <Box key={s.cmd} columnGap={2}>
              <Text color="cyanBright" bold>
                {s.cmd}
              </Text>
              <Text color="gray">{s.desc}</Text>
            </Box>
          ))}
        </Box>
      )}

      <Box borderStyle="round" borderColor="cyanBright" paddingX={1}>
        <Text color="cyanBright" bold>
          {ICONS.pointer}{" "}
        </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder="Enter task or /command..."
        />
      </Box>
    </Box>
  );
};
