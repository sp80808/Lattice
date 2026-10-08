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

Each workspace is a history-less snapshot of one commit (`git archive` into a fresh single-commit repo), so the gold fix and later commits are not reachable through git, and `leakage_guard.exclude_paths_from_context` is deleted before anything runs. Optional `acceptance.setup` commands (install, build) run first. A setup failure, a patch that does not apply, or a leak makes the run **inconclusive**: it never counts as a pass or as a discriminating failure.

Results are written as a run log (`.lattice/runs/dogfood-*.jsonl`, or `--out`) that `@lattice/ledger` reads: one `tool.completed` experiment per phase with `command` evidence for each acceptance command. Exit code 0 means verified/discriminating, 1 failed/not discriminating, 2 inconclusive.

## Status

Seed manifests plus a runner for calibration, candidate patches and external agents. Still open under #41: running cases through `lattice run` itself, the held-out checks listed in each manifest, and growing the corpus to six cases.
