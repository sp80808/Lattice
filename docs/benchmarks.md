# Benchmark harness

```bash
lattice bench [suite-dir] [flags]     # see docs/cli.md for flags
lattice bench --check                 # verify every fixture fails as shipped
```

The harness exists to answer one question cheaply: **does Lattice's
orchestration reach a verified fix in fewer rounds and verifier runs than a
worse decision policy would?** Generator and executor are deterministic
stand-ins, so the only variable between runs is the decision strategy. That
isolates orchestration logic from model quality; plug a real decision model in
with `--config -s configured` to measure that too.

The design follows the 2026 agent-evaluation literature (SWE-bench, Terminal-Bench 2.0):

- **Outcome-driven verification.** A task passes only when an objective
  verifier passes; agent/model claims never promote themselves.
- **Verifier runs and invalid edits are metered.** Cost per solved task is the
  primary metric (GLM-5 reaching SWE-bench ProMax parity at ~1/20th of Sonnet's
  cost is the kind of tradeoff this harness is built to see).
- **Failure classification.** Terminal-Bench's command-failure analysis found
  "executable not installed / not in PATH" is the single most common failure
  (24.1%); each unsolved trial is classified `command-not-found`, `timeout`,
  `invalid-edit`, `verifier-failed` or `no-experiment` instead of one opaque
  "failed".
- **pass@k.** Nondeterministic strategies are sampled, and pass@k uses the
  unbiased estimator (Chen et al., 2021) rather than a naive maximum.
- **Sharding and a regression gate.** `--shard i/n` splits tasks across CI
  runners; `--baseline` exits `1` when a strategy's solve rate regresses.

## Suite format

A suite is a directory of tasks:

```text
benchmarks/basic/
  calc-add-sign/
    task.json          # spec: verifier + candidates
    repo/              # fixture copied into a temp dir per trial
      src/calc.js
      test/calc.test.js
```

`task.json`:

```json
{
  "id": "calc-add-sign",
  "description": "add() subtracts instead of adding",
  "task": "fix the failing add test",
  "requires": ["tsr"],
  "metadata": { "category": "software", "difficulty": "easy" },
  "verify": {
    "command": "{NODE}",
    "args": ["--test", "test/"],
    "timeoutMs": 60000,
    "expectStdout": "optional exact stdout match"
  },
  "candidates": [
    { "id": "inspect", "label": "Inspect", "action": "read src/calc.js", "expectedEvidence": "source of add()", "estimatedCost": "low" },
    { "id": "fix-add", "label": "Use + in add()", "action": "use +", "expectedEvidence": "add test passes",
      "estimatedCost": "medium",
      "patch": { "file": "src/calc.js", "find": "a - b", "replace": "a + b" },
      "solves": true }
  ]
}
```

Rules (validated at load time):

- exactly one candidate sets `solves`, and it must carry a `patch`;
- candidate ids are kebab-unique and never `__none__`;
- `verify.command` supports `{NODE}` and `{TSR}` substitution;
- a verifier that exits 0 but does not match `expectStdout` fails;
- `metadata.difficulty` (when present) drives the report's difficulty rollup;
- tasks requiring missing tools are **skipped**, not failed.

Candidates that apply a patch to a file that does not exist, or whose `find`
text is absent, count as `invalidEdits` — the harness's proxy for a
hallucinated repository claim — and the patch is never applied.

## Strategies

| Strategy | Picks |
|---|---|
| `first` | the first offered candidate (a deliberately myopic baseline) |
| `random` | a uniform draw over real candidates (seed-hashed PRNG) |
| `cheapest-first` | lowest `estimatedCost`, ties in list order |
| `oracle` | the `solves` candidate: the best any decision model could do |
| `configured` | a real decision model from `--config` (tokens/cost are then metered) |

Deterministic strategies run once per task; `random` and `configured` repeat
`--trials` times with `seed + trial`, since repetition is what makes solve-rate
confidence intervals meaningful. `maxRounds` defaults to 2 — half the candidate
budget — so a wasteful policy can actually fail rather than merely cost more.

## Report

`formatReport` prints a strategy table (solve rate, 95% Wilson CI, pass@k,
experiments, verifier runs, decisions, tokens, cost, invalid edits, wall time),
per-task and per-difficulty breakdowns, and the failure histogram. `--out`
writes the same report as JSON, including every trial result and provenance
(suite digest, Lattice and tsr git revisions, Node version, concurrency).

## Adding fixtures

1. Create `<suite>/<task-id>/repo/` with a failing repository.
2. Add `task.json` with one `solves` candidate whose patch fixes it.
3. `lattice bench --check` must report every task failing as shipped and
   passing with its solution. Tessera fixtures additionally require the real
   `tsr` compiler (auto-skipped when absent).

Keep fixtures small and deterministic: the suite digest fingerprints task
specs and fixture files, and the regression gate compares digests to warn when
baseline and candidate measured different task sets.
