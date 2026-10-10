import type { WorkflowMode } from "../state/types.js";

const glyphs = {
  L: ["█    ", "█    ", "█    ", "█    ", "█████"],
  A: [" ███ ", "█   █", "█████", "█   █", "█   █"],
  T: ["█████", "  █  ", "  █  ", "  █  ", "  █  "],
  I: ["█████", "  █  ", "  █  ", "  █  ", "█████"],
  C: [" ████", "█    ", "█    ", "█    ", " ████"],
  E: ["█████", "█    ", "████ ", "█    ", "█████"],
};
export const WORKFLOW_MODES: WorkflowMode[] = ["plan", "build", "auto"];
export const nextWorkflow = (mode: WorkflowMode): WorkflowMode => WORKFLOW_MODES[(WORKFLOW_MODES.indexOf(mode) + 1) % 3]!;
export const modeColor = (mode: WorkflowMode) => ({ plan: "yellow", build: "cyan", auto: "magenta" })[mode];
export const ICONS = {
  mesh: [
    "        .----+----+----.",
    "     .-/----/----/----/ `.",
    "   .-+----+----+----+----+.",
    "  / /    /    /    /    / /",
    "  +----+----+----+----+ /",
    "   \\    \\    \\    \\    \\/",
    "    `----+----+----+----'",
  ],
  logo: Array.from({ length: 5 }, (_, row) => [..."LATTICE"].map(letter => glyphs[letter as keyof typeof glyphs][row]).join(" ")),
  sparkle: "✦",
  diamond: "◈",
  hexagon: "⬡",
  hexagonFilled: "⬢",
  latticeNode: "❖",
  bolt: "⚡",
  pointer: "❯",
  check: "✔",
  cross: "✖",
  warn: "▲",
  bullet: "•",
  arrowRight: "→",
  clock: "◷",
  evidence: "◈ TAP",
};

export const LATTICE_SPINNER_FRAMES = [
  "⬡ ⬢ ⬡",
  "⬢ ⬡ ⬢",
  "◈ ❖ ◈",
  "❖ ◈ ❖",
  "✦ ⟡ ✦",
  "⟡ ✦ ⟡",
];
