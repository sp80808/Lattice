# Consolidation mining

`lattice mine` proposes deterministic rules and Tessera-style failure/fix memory tiles from the normalized replay ledger.

It does **not** install or trust them.

```bash
lattice mine
lattice mine --json .lattice/runs
lattice mine --out .lattice/proposals --rules 5 --tiles 5
```

## Rule proposals

A rule candidate is emitted only when:

- the decision has objective downstream evidence;
- the normalized decision/option signature has enough support;
- verified success meets the configured threshold;
- one selected option dominates strongly enough.

Defaults are intentionally conservative:

- minimum support: 3;
- minimum verified success: 95%;
- minimum dominant-selection share: 90%.

Every proposal is marked `state: inferred` and records replay evidence handles. Promotion remains false until held-out replay and review exist.

The initial matcher is deliberately coarse and proposal-only. Runtime deterministic rules should use a separately reviewed matcher format with explicit escape/unknown behavior.

## CTX-style failure/fix tiles

A tile candidate is emitted when the same run contains:

1. an objectively observed failed experiment; and
2. a later objectively verified successful experiment.

The tile records:

- task/revision scope when known;
- failed decision class and option;
- an `avoid` description;
- a later `prefer` description;
- run/round provenance.

This is **correlational memory**, not causal proof. Tiles start `inferred`, require reproduction and review, and should later map onto Tessera CTX trust/freshness semantics.

## Proposal artifacts

`--out <dir>` writes:

- `rules.proposed.json`
- `tiles.proposed.json`
- `mining-report.json`

These files are designed to become ordinary reviewable PR artifacts in a later automation slice.

## Shared ledger

Calibration, consolidation mining and future policy replay all use `@lattice/ledger`, which normalizes current JSONL event shapes into frames, decisions, human reviews and experiments.

This shared interpretation layer is important: self-improvement loops must not disagree about what counts as a decision or objective outcome.
