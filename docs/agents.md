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

Then add patch promotion: a verified retained worktree should be convertible into a reviewable commit/patch and merged only after policy/approval.
