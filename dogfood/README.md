# Self-dogfood corpus (D2)

Frozen historical Lattice/Tessera defects turned into replayable case manifests for the dogfood ladder ([#39](https://github.com/sp80808/Lattice/issues/39), [#41](https://github.com/sp80808/Lattice/issues/41)).

## Seeds

| Case | Class | Repo | Base SHA |
| --- | --- | --- | --- |
| `lattice-false-green` | verification-integrity | Lattice | `ba2b643…` |
| `tessera-tcap-binder` | semantic-multi-structure | Tessera | `7c82b87…` |
| `tessera-mir-asymptotic` | performance-semantic-preservation | Tessera | `bfb9e2e…` |

## Rules

- Start from the exact `base_sha` in an isolated worktree.
- Keep `reference.gold_fix_sha` and historical fix notes **out of** the agent execution context (`leakage_guard`).
- Task statements must not leak the human fix.
- Acceptance must distinguish broken base from fixed behaviour.
- Integrity hardening (held-out checks, contamination labels) is tracked in [#49](https://github.com/sp80808/Lattice/issues/49).

## Schema

See `schema/case-manifest.v0.schema.json`. Corpus index: `index.json`.

## Running a case

`scripts/dogfood-run.mjs` runs a case from a local clone that contains its frozen commits:

```bash
npm run dogfood -- lattice-false-green --source .                       # calibrate (default)
npm run dogfood -- tessera-tcap-binder --source ../Tessera --patch fix.patch
npm run dogfood -- tessera-tcap-binder --source ../Tessera --agent 'claude -p "$LATTICE_DOGFOOD_TASK"'
```

- **Calibrate** runs acceptance at `base_sha` and at `reference.gold_fix_sha` and reports, per command, whether it tells them apart. A case is only usable when the base fails and the gold fix passes.
- **Patch** applies a candidate diff to `base_sha` and runs acceptance.
- **Agent** runs a command in the base workspace with the task statement on stdin and in `LATTICE_DOGFOOD_TASK`, captures its diff, then runs acceptance.

Each workspace is a history-less snapshot of one commit (`git archive` into a fresh single-commit repo), so the gold fix and later commits are not reachable through git, and `leakage_guard.exclude_paths_from_context` is deleted before anything runs. Files listed in `acceptance.held_out_from_gold` are copied from the gold fix after the patch or agent has run, so the fix's own tests judge the change without the agent seeing them. Optional `acceptance.setup` commands (install, build) run next. A setup failure, a patch that does not apply, or a leak makes the run **inconclusive**: it never counts as a pass or as a discriminating failure.

Results are written as a run log (`.lattice/runs/dogfood-*.jsonl`, or `--out`) that `@lattice/ledger` reads: one `tool.completed` experiment per phase with `command` evidence for each acceptance command. Exit code 0 means verified/discriminating, 1 failed/not discriminating, 2 inconclusive.

## Benchmark

`npm run dogfood:bench` runs the pinned suite in `bench/v1.json`: every agent, every discriminating case, a fixed number of attempts, one run at a time. It recalibrates each case first and refuses to score agents on one that does not tell base from gold. Runs append to `runs.jsonl` and a rerun resumes, so an interrupted run or a usage limit loses nothing. A run is solved only when acceptance passes and the transcript shows no sign of the source clone, the gold SHA or PR, or the case manifests. Each agent's diff is kept for audit. The report (`REPORT.md`) lists solve rate, turns, tokens, cost, the pinned inputs and the rerun command.

First full run: [`benchmarks/results/dogfood-bench-v1`](../benchmarks/results/dogfood-bench-v1/README.md). Haiku, Sonnet and Opus 5.5 each solved 6/6 and the no-op control 0/6, so v1 needs harder cases before it can rank models.

## Calibration (2026-10-11)

| Case | Verdict | Discriminating command |
| --- | --- | --- |
| `lattice-false-green` | discriminating | `npm test`, and (since 2026-10-15) the held-out check that a failing example makes `check-examples.sh` fail without its success banner |
| `tessera-tcap-binder` | discriminating, with `tests/derive.rs` held out from the gold fix | `cargo test -p tessera-tcap` |
| `tessera-mir-asymptotic` | **not discriminating** | none: the gold fix adds no test, so a scaling check has to be written |

## Status

Seed manifests plus a runner for calibration, candidate patches and external agents. Still open under #41: running cases through `lattice run` itself, the held-out checks listed in each manifest, and growing the corpus to six cases.
