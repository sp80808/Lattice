# Lattice Interactive TUI & CLI Dispatch Architecture

## Executive Summary
This document specifies the interactive Terminal User Interface (TUI) for Lattice (`@lattice/tui`) and the revised CLI dispatch behavior in `apps/cli`.
Running `lattice` in an interactive terminal opens a rich Ink-based TUI for tasks, planning, diagnostics, diff inspection, and decision review. Running `lattice help`, `lattice -h`, or `lattice --help` continues to output standard command line usage.

---

## 1. CLI Dispatch & Entry Point Routing

### 1.1 Command Resolution Logic
In [`apps/cli/src/index.ts`](file:///Volumes/Harry/DEV/Tessillate/Lattice/apps/cli/src/index.ts):
```
                       ┌─────────────────────────┐
                       │      lattice <argv>     │
                       └────────────┬────────────┘
                                    │
                                    ▼
                         Is first argument set?
                                   / \
                            No    /   \   Yes
                                 /     \
                                ▼       ▼
                   Is stdin/stdout TTY?  Is it help / -h / --help?
                         /     \                    /   \
                  Yes   /       \   No       Yes   /     \   No
                       ▼         ▼                ▼       ▼
               Launch @lattice/tui   Print HELP  Print HELP   Command / Task Dispatch
```

1. **Bare `lattice` with TTY**:
   * Evaluates `process.stdin.isTTY && process.stdout.isTTY`.
   * When `true`, dynamically imports `@lattice/tui` via `const { runTui } = await import("@lattice/tui")` and executes `runTui(globals)`.
   * Preserves fast startup for headless commands (zero React/Ink overhead for batch tasks).
2. **Bare `lattice` without TTY (CI / Pipes / Automation)**:
   * Prints the global `HELP` message and exits `0`.
3. **Explicit Help Flags**:
   * `lattice help`, `lattice -h`, `lattice --help`: Prints global usage and available tasks/commands.
   * `lattice help <command>` / `lattice <command> --help`: Prints command-specific usage flags.
4. **Task Shorthand & Commands**:
   * `lattice "task description"` or `lattice run <task>`: Executes headless task runner unchanged.
   * `lattice doctor`, `lattice bench`, `lattice plan`, etc.: Continues executing headless subcommands.

---

## 2. Package Architecture & Monorepo Layout

### 2.1 Workspace Placement
* **Location**: [`apps/tui`](file:///Volumes/Harry/DEV/Tessillate/Lattice/apps/tui)
* **Package Name**: `@lattice/tui`
* **Version**: `0.0.1` (private workspace package)
* **Root References**:
  * Root [`package.json`](file:///Volumes/Harry/DEV/Tessillate/Lattice/package.json): Included under `"workspaces": ["packages/*", "apps/*"]`.
  * Root [`tsconfig.json`](file:///Volumes/Harry/DEV/Tessillate/Lattice/tsconfig.json): Included in `references` as `{"path": "./apps/tui"}`.

### 2.2 Dependencies
```json
{
  "name": "@lattice/tui",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./dist/index.js"
    }
  },
  "dependencies": {
    "@lattice/protocol": "0.0.1",
    "@lattice/service": "0.0.1",
    "ink": "^5.1.0",
    "ink-spinner": "^5.0.0",
    "ink-text-input": "^5.0.1",
    "react": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.18"
  }
}
```

### 2.3 Compilation Configuration
* `apps/tui/tsconfig.json` extends workspace standards:
  * `"jsx": "react-jsx"`
  * `"module": "NodeNext"`
  * `"moduleResolution": "NodeNext"`
  * `"target": "ES2022"`
  * `"composite": true`
  * Project references to `../../packages/protocol` and `../../packages/service`.

---

## 3. UI Component Architecture

The TUI is organized into modular React/Ink components in `apps/tui/src/components/`:

```
apps/tui/src/
├── index.ts                   # runTui(options) entrypoint
├── App.tsx                    # Root state machine & layout
├── state/
│   ├── types.ts               # Session state, event feed models
│   └── useSession.ts          # State reducer & service bindings
├── components/
│   ├── Header.tsx             # Version, CWD, environment badges
│   ├── PromptBar.tsx          # Text input, command autocomplete popup
│   ├── EventStream.tsx        # Live spinner, rounds, TAP evidence feed
│   ├── DecisionReview.tsx     # Supervised autonomy decision picker
│   ├── DiffViewer.tsx         # Colorized patch / diff viewer
│   └── CommandOutput.tsx      # Formatted outputs (/doctor, /runs, /config)
└── commands/
    ├── registry.ts            # Slash command definitions & tab-completion
    └── handlers.ts            # /doctor, /plan, /runs, /show, /diff, /config
```

### 3.1 State Machine
The session operates across four primary modes:
1. `idle`:
   * Displays prompt bar with cursor.
   * Auto-suggests slash commands when input begins with `/`.
   * Accepts plain text as a task query to run.
2. `running`:
   * Locks prompt input.
   * Renders `EventStream` with active spinner, round indicators, and streamed TAP evidence cards.
   * Cancels cleanly on `Ctrl+C` or `Esc` (triggers task abort signal).
3. `reviewing`:
   * Suspends execution loop when supervised/manual autonomy triggers a human decision frame.
   * Renders `DecisionReview`:
     * Choice list with candidate IDs, cost/evidence notes.
     * Keyboard hotkeys: `[Enter]` to approve selection, `[r]` to submit text refinement, `[1-N]` to select candidate ID override, `[s]` to stop.
4. `diff`:
   * Inspects unified diff for run candidate or working tree changes.
   * Allows paging / scrolling lines before returning to `idle`.

---

## 4. Slash Commands & Capabilities

| Command | Action |
|---|---|
| `/doctor` | Invokes `runDoctor`, displays node/git/config/model status matrix. |
| `/plan <task>` | Generates source-grounded markdown plan without running agents. |
| `/runs [limit]` | Queries `listRuns`, displays tabular history of recent executions. |
| `/show <id>` | Queries `getRun`, displays summary, telemetry, and evidence count. |
| `/diff [id]` | Displays patch diff for specified run or latest candidate. |
| `/config` | Loads resolved configuration and displays active provider/model/verifier settings. |
| `/clear` | Clears terminal screen buffer. |
| `/help` | Displays keyboard shortcuts and slash command index. |
| `/exit`, `/quit` | Exits the TUI process cleanly. |

---

## 5. Error Handling & Resilience
* **Graceful Exit**: Handles `SIGINT` (`Ctrl+C`) and `SIGTERM`. If a task is executing, aborts worktree/service loop safely before closing Ink render tree.
* **Non-TTY Fallback**: Directly catches non-interactive environments and routes to standard text help.
* **Terminal Resize**: Relies on Ink's standard flexbox terminal layout with dynamic column width clamping.
* **Error Containment**: Boundary errors in components render an in-TUI error card rather than crashing the node process.

---

## 6. Testing & Verification
1. **Unit tests**:
   * Test CLI routing in `apps/cli/src/index.test.ts` for:
     * `lattice` without args in non-TTY environment outputs `HELP`.
     * `lattice help`, `lattice -h`, `lattice --help` outputs `HELP`.
     * Command-specific help output.
   * Test slash command registry and argument parsing in `apps/tui/src/commands/registry.test.ts`.
2. **Build and lint verification**:
   * Root `npm run build` (`tsc -b`) compiles `apps/tui` without type errors.
   * Full test suite `npm test` passes cleanly.
