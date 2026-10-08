# Isolated coding-agent adapters

Lattice should treat existing coding agents as interchangeable workers rather than rebuilding every editor/tool loop itself.

The v0 agent runner uses two boundaries:

1. **AgentAdapter** — normalize a coding agent into `run(task, workspace)`.
2. **detached Git worktree** — ensure a mutating worker cannot edit the parent's working tree.

## Generic process adapter

A CLI can be configured with argument templates:

```ts
new ProcessAgentAdapter({
  name: "opencode",
  command: "opencode",
  args: ["run", "{prompt}"],
})
```

Qwen Code currently supports headless prompting and structured output, so a future built-in preset can use a shape such as:

```text
qwen --prompt "{prompt}" --output-format json
```

The generic adapter exists so these presets remain thin compatibility layers rather than orchestration forks.

## Built-in process presets

Lattice now exposes thin preset factories for the current headless CLIs:

```ts
const qwen = createQwenCodeAdapter({
  // default is conservative; explicitly opt into broader autonomy when wanted
  approvalMode: "auto-edit",
  outputFormat: "json",
});

const opencode = createOpenCodeAdapter({
  format: "json",
  autoApprove: false,
});
```

Qwen Code's current headless surface supports `qwen --prompt/-p`, structured `--output-format`, and explicit approval modes. OpenCode's current non-interactive surface is `opencode run`, with JSON output and optional `--auto`.

Lattice does **not** enable the broadest approval mode by default.

## Execution security (what is and is not isolated)

A detached Git worktree isolates **source state only**. It is not a security
sandbox: a worker still runs as your OS user and can read files elsewhere in
your account, reach the network, and touch the shared `.git` directory. Treat
repository text (README, comments, issues) as untrusted input that can steer
a worker. Filesystem, network and Git-metadata confinement are tracked in #52
and are not implemented yet.

What Lattice enforces today for every process agent:

- **Minimal environment.** A worker receives only `PATH`, locale, `TERM`,
  `TZ`, temp-dir variables (plus the Windows essentials), any names the
  adapter declares in `allowEnv`, and explicit `env` values. Unrelated
  secrets in the Lattice process are withheld. The Qwen Code and OpenCode
  presets declare their provider keys and `HOME`/XDG dirs (where their login
  state lives) in `QWEN_CODE_ENV` and `OPENCODE_ENV`; pass `allowEnv` to
  narrow or replace that list.
- **Recorded, never logged values.** The policy and variable names reach the
  agent's model evidence (`env=minimal:PATH,...`); values never do.
- **Process-tree cleanup.** Workers and verify commands run in their own
  process group. A timeout terminates the whole group (SIGTERM, then SIGKILL
  after a grace period), and once the worker exits any descendant it left
  running is killed. A process that calls `setsid()` itself escapes this
  until a real sandbox backend exists. On Windows, timeouts use
  `taskkill /T`.
- **Explicit opt-out.** `trustedHost: true` (config `agent.trustedHost`)
  passes the full parent environment. Use it for local debugging only;
  Lattice never falls back to it on its own.

## Worktree policy

Each mutating subagent receives a detached worktree at the parent's pinned revision.

Lattice captures:

- process exit status;
- stdout/stderr;
- changed files;
- tracked diff;
- untracked file names;
- optional verification command;
- retained/cleaned workspace state.

The parent's working tree is never directly handed to a mutating child.

## Truth hierarchy

A zero exit code from a coding agent does **not** prove its patch is correct.

The agent output becomes unverified `model` evidence. Only an objective verifier (test/build/lint/benchmark or other trusted tool) can promote the search result to terminal success.

This is why `createAgentExperimentExecutor` returns `inconclusive` when the agent exits successfully but no verifier passes.

## Open-source jumping-off points

- Qwen Code uses separate-context subagents and exposes headless CLI execution.
- OpenCode exposes a scriptable `opencode run` path.
- OpenHands supports local and ephemeral workspaces.
- goose delegates subagents into isolated sessions.
- ACP is the preferred next protocol adapter for richer agent events, permissions and child sessions.

## Next

Add preset adapters only where they reduce setup friction:

- Qwen Code process preset;
- OpenCode process preset;
- Codex through ACP/App Server rather than scraping terminal output;
- general ACP agent adapter.

Verified patch promotion is now available through `promoteVerifiedRun`. It refuses to promote candidates that lack passing objective verification, creates a dedicated branch in the isolated worktree, stages all candidate changes, and creates a reviewable commit without moving the parent's checked-out branch.

## Bounded parallel scheduling

`runParallelAgents` now provides a deliberately small worker-pool scheduler:

- all children are pinned to the same base revision before launch;
- concurrency is capped (default 2);
- result ordering is deterministic even when completion order differs;
- each child still gets its own detached worktree;
- failures are normalized instead of crashing sibling jobs;
- `stopLaunchingAfterVerified` can avoid starting queued expensive work once a verified candidate exists;
- already-running children are allowed to finish for now rather than being killed unsafely.

`verifiedBatchResults` filters the batch down to candidates backed by passing verification. Selection/ranking among multiple verified survivors remains a separate policy decision so the scheduler does not smuggle in arbitrary notions of "best".

Next:
- cancellation/AbortSignal propagation for already-running children;
- branch/commit promotion policy in the parent orchestrator;
- Qwen/OpenCode structured event parsing for cost/session metadata;
- ACP-native Codex/Qwen integration instead of terminal-output parsing where possible.
