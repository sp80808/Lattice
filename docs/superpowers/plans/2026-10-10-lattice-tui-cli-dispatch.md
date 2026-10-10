# Lattice Interactive TUI & CLI Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the interactive `@lattice/tui` package powered by Ink and update `apps/cli` so running `lattice` launches the TUI on interactive terminals, while `lattice help` displays command usage.

**Architecture:** A dedicated workspace package `apps/tui` (`@lattice/tui`) containing Ink/React terminal UI components, driven by `@lattice/service`. The CLI entry point in `apps/cli/src/index.ts` lazily imports `@lattice/tui` when invoked without arguments in a TTY, and routes `help`/`--help` to static documentation.

**Tech Stack:** Node.js (>=22), TypeScript (NodeNext), Ink v5, React 18, ink-text-input, ink-spinner, `@lattice/service`, `@lattice/protocol`.

**Spec:** [`docs/superpowers/specs/2026-10-10-lattice-tui-cli-dispatch-design.md`](file:///Volumes/Harry/DEV/Tessillate/Lattice/docs/superpowers/specs/2026-10-10-lattice-tui-cli-dispatch-design.md)

## Global Constraints
- TypeScript ESM with `"moduleResolution": "NodeNext"`.
- Clean non-TTY fallback for CI and headless scripts.
- Zero startup regression for batch CLI commands (`apps/cli` lazy-loads `@lattice/tui`).
- All existing tests in `npm test` must continue to pass.

---

### Task 1: CLI Dispatch & Help Routing Updates

**Files:**
- Modify: `apps/cli/src/index.ts:104-124`
- Modify: `apps/cli/src/index.test.ts`

**Interfaces:**
- Consumes: `process.stdin.isTTY`, `process.stdout.isTTY`, `HELP`
- Produces: Updated entrypoint in `apps/cli/src/index.ts` that checks TTY and delegates bare invocation to `@lattice/tui` or `HELP`.

- [ ] **Step 1: Write test for CLI dispatch in `apps/cli/src/index.test.ts`**
Add unit tests verifying:
1. `lattice --help`, `lattice -h`, and `lattice help` output `HELP` and exit 0.
2. In non-TTY environments, bare `lattice` outputs `HELP`.

```typescript
test("lattice help and -h display global help", async () => {
  const { stdout, code } = await runCli(["help"]);
  assert.equal(code, 0);
  assert.match(stdout, /Lattice 0\.0\.1 — generate less/);
});
```

- [ ] **Step 2: Update `apps/cli/src/index.ts` routing logic**
Update `main` function:
```typescript
async function main(argv: string[]): Promise<number> {
  const { globals, remaining } = hoistGlobals(argv);
  const [first, ...tail] = remaining;
  const rest = [...globals, ...tail];

  if (first === undefined) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      try {
        // @ts-ignore - resolved once @lattice/tui is linked
        const { runTui } = await import("@lattice/tui");
        return await runTui(globals);
      } catch (err: any) {
        if (err?.code !== "ERR_MODULE_NOT_FOUND" && !err?.message?.includes("Cannot find package '@lattice/tui'")) {
          throw err;
        }
      }
    }
    console.log(HELP);
    return 0;
  }

  if (first === "help" || first === "-h" || first === "--help") {
    console.log(HELP);
    return 0;
  }

  if (first === "-v" || first === "--version" || first === "version") {
    console.log(LATTICE_VERSION);
    return 0;
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(HELP);
    return 0;
  }

  const command = COMMANDS[first];
  return command ? command(rest) : runCommand([...globals, ...remaining]);
}
```

- [ ] **Step 3: Run existing CLI tests**
Run: `npm run build && node --test apps/cli/dist/index.test.js`
Expected: PASS

- [ ] **Step 4: Commit**
```bash
git add apps/cli/src/index.ts apps/cli/src/index.test.ts
git commit -m "feat(cli): support 'help' command and prepare TUI routing"
```

---

### Task 2: Scaffold `@lattice/tui` Package & Dependencies

**Files:**
- Create: `apps/tui/package.json`
- Create: `apps/tui/tsconfig.json`
- Modify: `package.json:6-9`
- Modify: `tsconfig.json:52-58`
- Modify: `apps/cli/package.json:9-18`

**Interfaces:**
- Produces: `@lattice/tui` package in monorepo workspaces and build graph.

- [ ] **Step 1: Create `apps/tui/package.json`**
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

- [ ] **Step 2: Create `apps/tui/tsconfig.json`**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "jsx": "react-jsx",
    "strict": true,
    "composite": true,
    "sourceMap": true,
    "rootDir": "src",
    "outDir": "dist",
    "skipLibCheck": true
  },
  "references": [
    {
      "path": "../../packages/protocol"
    },
    {
      "path": "../../packages/service"
    }
  ],
  "include": [
    "src/**/*.ts",
    "src/**/*.tsx"
  ]
}
```

- [ ] **Step 3: Update root `tsconfig.json` and `apps/cli/package.json`**
Add `{"path": "./apps/tui"}` to root `tsconfig.json` references.
Add `"@lattice/tui": "0.0.1"` to `apps/cli/package.json` dependencies and `apps/cli/tsconfig.json` references.

- [ ] **Step 4: Install packages and link workspace**
Run: `npm install`
Expected: Dependencies installed and workspace symlinks created.

- [ ] **Step 5: Commit**
```bash
git add apps/tui/package.json apps/tui/tsconfig.json tsconfig.json apps/cli/package.json apps/cli/tsconfig.json package-lock.json
git commit -m "chore(tui): scaffold @lattice/tui workspace package"
```

---

### Task 3: TUI State Model, Header, and PromptBar

**Files:**
- Create: `apps/tui/src/state/types.ts`
- Create: `apps/tui/src/components/Header.tsx`
- Create: `apps/tui/src/components/PromptBar.tsx`

**Interfaces:**
- Produces: `TuiSessionState`, `Header` component showing project status, `PromptBar` with text input and slash completion.

- [ ] **Step 1: Define state types in `apps/tui/src/state/types.ts`**
```typescript
import type { RunEvent, RunResult } from "@lattice/protocol";

export type TuiMode = "idle" | "running" | "reviewing" | "diff";

export interface LogEntry {
  id: string;
  type: "info" | "success" | "warning" | "error" | "output";
  message: string;
  timestamp: Date;
}

export interface TuiSessionState {
  mode: TuiMode;
  cwd: string;
  configPath?: string;
  logs: LogEntry[];
  currentTask?: string;
  events: RunEvent[];
  lastResult?: RunResult;
}
```

- [ ] **Step 2: Implement `Header.tsx`**
Renders banner with version, current working directory, and mode indicators using `ink`.

- [ ] **Step 3: Implement `PromptBar.tsx`**
Uses `ink-text-input` to capture user input, showing autocomplete suggestions when input starts with `/`.

- [ ] **Step 4: Build and verify components compile**
Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add apps/tui/src/state/types.ts apps/tui/src/components/Header.tsx apps/tui/src/components/PromptBar.tsx
git commit -m "feat(tui): add state models, Header, and PromptBar components"
```

---

### Task 4: Slash Command Handlers & Dispatcher

**Files:**
- Create: `apps/tui/src/commands/registry.ts`
- Create: `apps/tui/src/commands/handlers.ts`
- Create: `apps/tui/src/commands/registry.test.ts`

**Interfaces:**
- Consumes: `@lattice/service` (`runDoctor`, `listRuns`, `getRun`, `loadConfig`)
- Produces: Command router mapping `/doctor`, `/runs`, `/show`, `/config`, `/help`, `/clear`, `/exit`.

- [ ] **Step 1: Write unit test for command registry in `apps/tui/src/commands/registry.test.ts`**
Verify command registration, matching, argument parsing, and autocomplete helper.

- [ ] **Step 2: Implement registry and handlers**
Implement dispatch logic invoking `@lattice/service` functions and returning formatted output blocks for the TUI feed.

- [ ] **Step 3: Run command registry tests**
Run: `npm run build && node --test apps/tui/dist/commands/registry.test.js`
Expected: PASS

- [ ] **Step 4: Commit**
```bash
git add apps/tui/src/commands/
git commit -m "feat(tui): implement slash commands and registry"
```

---

### Task 5: EventStream, DecisionReviewModal, DiffViewer & `runTui`

**Files:**
- Create: `apps/tui/src/components/EventStream.tsx`
- Create: `apps/tui/src/components/DecisionReviewModal.tsx`
- Create: `apps/tui/src/components/DiffViewer.tsx`
- Create: `apps/tui/src/App.tsx`
- Create: `apps/tui/src/index.ts`

**Interfaces:**
- Consumes: `@lattice/service` (`executeTask`, `DecisionReviewer`), Ink `render`
- Produces: `runTui(options)` exported function that mounts the Ink root and runs the interactive session.

- [ ] **Step 1: Implement `EventStream.tsx`**
Renders active spinner using `ink-spinner` when `mode === "running"`, listing round numbers and collected TAP evidence tags in real time.

- [ ] **Step 2: Implement `DecisionReviewModal.tsx`**
Interactive Ink component for supervised autonomy frames, capturing keys:
- `Enter` or `a`: Approve
- `r`: Prompt for refinement note
- `1-9`: Candidate override
- `s`: Stop

- [ ] **Step 3: Implement `DiffViewer.tsx`**
Color-coded terminal diff display (green `+`, red `-`, cyan chunk headers).

- [ ] **Step 4: Implement `App.tsx` and `runTui` in `apps/tui/src/index.ts`**
Combines `Header`, `EventStream`, `DecisionReviewModal`, `DiffViewer`, and `PromptBar` into the complete application shell.

- [ ] **Step 5: Build and compile workspace**
Run: `npm run build`
Expected: All packages compile cleanly without type errors.

- [ ] **Step 6: Commit**
```bash
git add apps/tui/src/
git commit -m "feat(tui): complete App shell, EventStream, ReviewModal, and runTui"
```

---

### Task 6: Integration, Verification & Global Binary Validation

**Files:**
- Test: Full monorepo test suite

- [ ] **Step 1: Run complete monorepo test suite**
Run: `npm test`
Expected: All package tests pass.

- [ ] **Step 2: Re-link CLI globally**
Run: `cd apps/cli && npm link`
Expected: Symlinked `lattice` binary updated.

- [ ] **Step 3: Verify CLI commands**
Run: `lattice help` -> outputs help text.
Run: `lattice --version` -> outputs `0.0.1`.
Run: `lattice` (in interactive TTY) -> launches Lattice interactive TUI.

- [ ] **Step 4: Commit**
```bash
git commit --allow-empty -m "chore(tui): verify complete TUI integration and global binary"
```
