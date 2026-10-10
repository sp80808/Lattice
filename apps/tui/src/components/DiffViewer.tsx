import React from "react";
import { Box, Text, useInput } from "ink";
import { ICONS } from "../theme/icons.js";

interface DiffViewerProps {
  title: string;
  diffText: string;
  onClose: () => void;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({ title, diffText, onClose }) => {
  useInput((input, key) => {
    if (key.return || key.escape || input === "q") {
      onClose();
    }
  });

  const lines = diffText.split("\n").slice(0, 40); // clamp for terminal screen

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color="cyanBright" bold>
          {ICONS.diamond} {title}
        </Text>
        <Text color="gray">[Press Enter or 'q' to close]</Text>
      </Box>

      <Box flexDirection="column">
        {lines.map((line, idx) => {
          let color: string = "gray";
          if (line.startsWith("+") && !line.startsWith("+++")) {
            color = "greenBright";
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            color = "redBright";
          } else if (line.startsWith("@@")) {
            color = "cyan";
          } else if (line.startsWith("diff ") || line.startsWith("index ")) {
            color = "yellow";
          }

          return (
            <Text key={idx} color={color}>
              {line}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
};
