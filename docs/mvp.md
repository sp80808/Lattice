# Actionable MVP

## Goal

Demonstrate that Lattice can solve a small repository task using less expensive generation than a conventional agent loop while preserving or improving verification quality.

## MVP vertical slice

A user runs:

```bash
lattice "fix the failing tests"
```

Lattice:

1. indexes repository basics;
2. runs the failing tests;
3. creates a compact task packet;
4. asks a generator for several terse hypotheses/actions;
5. uses a cheap decision provider to rank them;
6. runs the most informative cheap experiment;
7. spawns one or more isolated implementation agents if justified;
8. validates their patches;
9. selects/merges only a verified patch;
10. reports outcome, evidence, cost and token usage.

## Milestone A — runnable skeleton

- TypeScript workspace.
- `lattice` CLI.
- daemon/core package.
- event log.
- shell/git execution.
- provider interfaces.
- one OpenAI-compatible generator.
- one Qwen/local or OpenAI-compatible decision provider.

Exit criterion: a mocked task can run end-to-end and be replayed.

## Milestone B — repository awareness

- file/symbol inventory;
- git SHA/worktree management;
- test-command discovery/configuration;
- compact context packet;
- evidence records.

Exit criterion: Lattice can reproduce a failing test and attach the result to a task packet without model-written repository facts.

## Milestone C — choice/search loop

Implement:

```text
generate N → rank → select experiment → execute → update → repeat
```

Required safeguards:

- `unknown/none` option;
- uncertainty threshold;
- maximum rounds/cost;
- objective evidence overrides decision scores.

Exit criterion: compare against random-selection baseline.

Harness: [`examples/tessera-repair`](../examples/tessera-repair/README.md)
repairs broken Tessera programs with `tsr witness` as the only judge and reports
rounds, verifications, tokens and cost per verified patch against a seeded
random decider (`models.decision.provider: "random"` does the same for any
configured run). Offline it runs with stub providers; the real-model numbers
are still to be collected.

## Milestone D — subagents

- isolated worktrees;
- child TAP slices;
- parallel task execution;
- deterministic verification;
- parent synthesis;
- cancellation/budget propagation.

Exit criterion: two alternative patches can be generated in parallel and the harness selects only a passing candidate.

## Milestone E — usable TUI/GUI

TUI first:

- chat/task input;
- current plan;
- running agents;
- evidence/results;
- diff;
- cost/tokens;
- approve/auto mode.

Web GUI then consumes the same daemon API.

## Initial configuration

Default:

```yaml
mode: auto
```

Advanced:

```yaml
models:
  decide: local/qwen
  generate: auto
  code: auto
  review: auto

strategy:
  accuracy: high
  cost: balanced
  parallelism: auto

verify:
  tests: auto
  lint: auto
  benchmark: optional
```

## Explicit non-goals for v0

- implementing the full Tessera compiler;
- supporting every coding-agent ecosystem;
- distributed orchestration;
- autonomous long-running deployment workflows;
- custom model training;
- polished marketplace/plugin system.

The MVP should prove the orchestration thesis first.
