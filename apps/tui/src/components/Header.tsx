import React from "react";
import { Box, Text } from "ink";
import { LATTICE_VERSION } from "@lattice/service";
import type { ViewState, WorkflowMode } from "../state/types.js";
import { ICONS, WORKFLOW_MODES, modeColor } from "../theme/icons.js";

interface HeaderProps {
  cwd: string;
  readiness: string;
  workflow: WorkflowMode;
  view: ViewState;
  columns: number;
  rows: number;
  showLogo: boolean;
}

export const Header: React.FC<HeaderProps> = ({ cwd, readiness, workflow, view, columns, rows, showLogo }) => (
  <Box flexDirection="column" marginBottom={1}>
    {showLogo && ICONS.mesh.map((line, index) => (
      <Text key={index} color={modeColor(workflow)} bold>{line}</Text>
    ))}
    <Text wrap="truncate"><Text color={modeColor(workflow)} bold>LATTICE</Text> {LATTICE_VERSION} <Text dimColor>· {view.toUpperCase()}</Text></Text>
    <Text wrap="truncate"><Text dimColor>project: </Text>{cwd}</Text>
    <Text wrap="truncate" color={/REQUIRED|ERROR|missing/.test(readiness) ? "yellow" : "gray"}>{readiness}</Text>
    {columns < 40 ? <Text color={modeColor(workflow)}>[{workflow.toUpperCase()}] · Shift+Tab</Text> : <Box columnGap={2}>
      {WORKFLOW_MODES.map(mode => <Text key={mode} color={mode === workflow ? modeColor(mode) : "gray"} bold={mode === workflow}>{mode === workflow ? `[${mode.toUpperCase()}]` : mode.toUpperCase()}</Text>)}
      {columns >= 70 && <Text dimColor>Shift+Tab  Switch mode</Text>}
    </Box>}
  </Box>
);
