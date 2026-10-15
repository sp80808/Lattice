# dogfood-bench-v1, first full run (2026-10-15)

Raw report: [REPORT.md](REPORT.md). Per-run records are in `runs.jsonl`, each agent's diff is in `patches/` and the calibration results are in `calibration.json`. Transcripts and run logs (15 MB) were not committed. Their paths in `runs.jsonl` point into the machine-local `.lattice/` directory.

## Findings

- **The suite works end to end, and the controls behave.** Both cases still discriminate: acceptance fails at the base and passes at the gold fix. The no-op agent scored 0/6, and no run was contaminated.
- **v1 does not separate the models.** Haiku 5.5, Sonnet 5.5 and Opus 5.5 each solved 6/6. The only differences are cost and time:

  | Agent | Solved | Agent time (total) | Cost (API list price) |
  | --- | --- | --- | --- |
  | Haiku 5.5 | 6/6 | 23.0m | $0.23 |
  | Sonnet 5.5 | 6/6 | 12.4m | $1.50 |
  | Opus 5.5 | 6/6 | 22.9m | $6.00 |

  For a headline comparison the corpus needs harder cases. A third case that *fails* for at least one of these models is the most valuable next addition (#41's target is six cases).
- **Diff size varies a lot.** On `tessera-tcap-binder`, every model edited only `src/derive.rs`, plus a new test file in two runs. On `lattice-false-green`, Haiku touched 5–7 files, Sonnet 9–11, and Opus 17–20. Opus also rewrote CI, the setup scripts and the test runner. These edits were audited by hand and do not game acceptance (Opus added a stricter test runner rather than a looser one), but nothing scores scope yet.
- **Usage limits.** Ten attempts first hit a Claude Code session limit (HTTP 429) and were scored as failures. The bench now stops on a 429 without recording the attempt. Those ten were discarded and rerun after the limit reset. The numbers above come from the rerun.

## Rerun

From a Lattice checkout with `../Tessera` cloned next to it (both with full history):

```bash
pnpm install --frozen-lockfile
npm run dogfood:bench                         # writes .lattice/dogfood-bench/dogfood-bench-v1/REPORT.md
# On a Mac where ANTHROPIC_BASE_URL points at a custom endpoint:
env -u ANTHROPIC_BASE_URL npm run dogfood:bench
```

The run is sequential, one agent at a time, and took about 1.5 hours wall clock in the cloud. If it is interrupted, or stops on a usage limit, the same command resumes it.
