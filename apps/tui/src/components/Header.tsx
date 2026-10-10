import React from "react";
import { Box, Text } from "ink";
import { ICONS } from "../theme/icons.js";

interface HeaderProps {
  cwd: string;
  configPath?: string;
  mode: string;
}

export const Header: React.FC<HeaderProps> = ({ cwd, configPath, mode }) => {
  const shortCwd = cwd.length > 40 ? "…" + cwd.slice(-38) : cwd;

  return (
    <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box flexDirection="column">
        {ICONS.logo.map((line, index) => (
          <Text key={index} color="cyanBright" bold>
            {line}
          </Text>
        ))}
      </Box>

      <Box marginTop={1} justifyContent="space-between">
        <Text color="gray">
          {ICONS.sparkle} <Text color="white" bold>Lattice 0.0.1</Text> — generate less, choose cheaply, verify everything.
        </Text>
        <Text color="yellowBright" bold>
          [{mode.toUpperCase()}]
        </Text>
      </Box>

      <Box marginTop={1} columnGap={2}>
        <Box>
          <Text color="gray">project: </Text>
          <Text color="white">{shortCwd}</Text>
        </Box>
        <Box>
          <Text color="gray">config: </Text>
          <Text color={configPath ? "greenBright" : "yellow"}>
            {configPath ? configPath : "evidence-only bootstrap"}
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
