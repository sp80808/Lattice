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

## Status

Seed manifests only. Wiring into worktree runners + the evidence ledger is follow-on work under #41.
