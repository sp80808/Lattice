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
a worker. Filesystem and network confinement are tracked in #52 and are not
implemented yet; worktree Git wiring is snapshotted, which detects rather than
prevents tampering.

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
- **Shared-ref tamper check.** Worktrees share branches and tags with the
  main checkout, so a worker can move them with `git update-ref` or
  `git branch -f`. Lattice snapshots `refs/heads` and `refs/tags` before the
  worker starts and after verification; any pre-existing ref that moved or
  vanished fails the run (`refTamper`, `ref_tamper=` in evidence) and blocks
  promotion. New refs are not flagged. The check cannot tell who moved a
  ref, so a commit you make in the main checkout during a run also fails it.
  It detects rather than prevents. The worktree `.git` file, absolute Git
  dir and top level are snapshotted too; objects, hooks and config inside
  the shared Git directory are not monitored.
- **Explicit opt-out.** `trustedHost: true` (config `agent.trustedHost`)
  passes the full parent environment. Use it for local debugging only;
  Lattice never falls back to it on its own.

## Verified change sets

Every run captures a complete, content-addressed candidate before the
verifier sees it (#54):

```text
WorkspaceChangeSet
  baseRevision          resolved commit, not a movable branch name
  entries[]             path, oldPath?, status, kind, modes,
                        contentDigest, size, binary, symlinkTarget
  changeSetDigest       sha256 of the canonical manifest
  patchDigest           digest of the captured rendering

WorkspaceChanges
  diff                  bounded human-readable rendering (not identity)
  changeSet             the manifest above
```

- **No porcelain parsing.** Tracked changes come from `git diff --raw
  --no-renames -z`; untracked files are enumerated with
  `git ls-files --others --exclude-standard -z`. Filenames containing
  spaces, newlines, unicode or leading dashes survive unchanged.
- **Full bytes, not previews.** Regular files are hashed from a
  no-follow file descriptor; symlinks hash their target; submodules record
  their gitlink. The display patch is capped (2 MiB by default) and never
  feeds the identity.
- **Stable rename representation.** A rename is a delete plus an add.
  That shape does not change when Git starts seeing the index during
  promotion, so verifying and staging the same bytes cannot drift.
- **Stable capture.** A file whose inode, size or nanosecond mtime changes
  while it is being read aborts capture instead of producing a torn hash.
- **Bounded candidates.** `maxFileBytes` (64 MiB) and `maxEntries` (2000)
  bound work; exceeding either is a policy violation, not a silent
  truncation of the identity.

### Candidate policy

`changesPolicy` controls what a candidate may contain. Defaults are
deliberate:

| Entry | Default | Opt-in |
|---|---|---|
| symlink | deny | `symlinks: "allow"` (target must stay inside the worktree) |
| submodule/gitlink | deny | `submodules: "allow"` |
| unmerged path | deny | not promotable at all |
| oversized file | deny | raise `maxFileBytes` |
| too many entries | deny | raise `maxEntries` |

Containment is checked independently of those switches: every changed
path's parent is resolved with `realpath`, so a tracked directory replaced
by an external symlink fails with `path-escape`. A symlink whose target
leaves the worktree fails with `symlink-escape` even when symlinks are
allowed.

### Verification is bound to the candidate

After the worker exits, Lattice snapshots the worktree's Git wiring
(`.git` file digest, absolute Git dir, top level) and rejects the run if it
moved. It also rejects a worker that committed: `HEAD` must remain at the
pinned base (`headMoved`).

The verifier then runs, and the worktree is recaptured. The run succeeds
only when the recaptured digest equals the captured digest. Any added,
removed or modified path, or a changed file mode, marks the verification
`trusted: false`; the result still records the verifier's output, but it is
not evidence of success and promotion refuses it. A verifier that writes
coverage or build output into the worktree must either keep it ignored by
Git or write outside the worktree.

`objectiveVerification()` folds all of these into its verdict: shared-ref
tamper, `HEAD` movement, Git-wiring changes, policy violations, capture
failure and untrusted verification all block `passed`. `verifiedBatchResults()`
and promotion use that verdict.

### Promotion commits exactly the manifest

`promoteVerifiedRun()`:

1. requires a successful, objectively verified run;
2. recaptures the worktree and refuses promotion if its digest differs from
   the verified one (late edits or new files);
3. resets the index to the pinned revision, discarding anything a worker
   staged outside the manifest;
4. stages only the manifest paths via `--pathspec-from-file=-`;
5. recaptures again and compares the digest after staging;
6. compares the staged raw manifest (path, status, mode) with the captured
   one;
7. switches to the promotion branch, points Git hooks at an empty directory,
   and commits with `--no-verify`;
8. re-reads the committed tree and checks it still matches the manifest.

Promotion therefore fails closed if a background process, a Git filter or a
repository hook tries to widen the change set between verification and commit.

## Worktree policy

Each mutating subagent receives a detached worktree at the parent's pinned revision.

Lattice captures:

- process exit status and stdout/stderr;
- the complete change-set manifest and its digest;
- a bounded tracked+untracked patch for review;
- symlink, submodule and mode changes explicitly;
- optional verification output and whether it stayed bound to the manifest;
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
