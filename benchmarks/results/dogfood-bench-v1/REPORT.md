# dogfood-bench-v1 results

A case counts as solved when every acceptance command passes, with the gold fix's held-out tests copied in after the agent finished, and the agent's transcript shows no sign of reaching the gold fix. Inconclusive runs (setup failed, agent timed out) count as unsolved.

## Solve rate

| Agent | Solved | `lattice-false-green` | `tessera-tcap-binder` | Agent time | Cost |
| --- | --- | --- | --- | --- | --- |
| `noop` | 0/6 (0%) | 0/3 (✗✗✗) | 0/3 (✗✗✗) | 0.0m | – |
| `claude-code-haiku-5-5` | 6/6 (100%) | 3/3 (✓✓✓) | 3/3 (✓✓✓) | 23.0m | $0.23 |
| `claude-code-sonnet-5-5` | 6/6 (100%) | 3/3 (✓✓✓) | 3/3 (✓✓✓) | 12.4m | $1.50 |
| `claude-code-opus-5-5` | 6/6 (100%) | 3/3 (✓✓✓) | 3/3 (✓✓✓) | 22.9m | $6.00 |

✓ solved, ✗ acceptance failed, ? inconclusive, ! contaminated. Cost is what Claude Code reports, at API list prices.

## Calibration

| Case | Verdict | Reason |
| --- | --- | --- |
| `lattice-false-green` | discriminating | base fails and gold fix passes |
| `tessera-tcap-binder` | discriminating | base fails and gold fix passes |

## Cases left out

- `tessera-mir-asymptotic`: Not discriminating: the gold fix added no test, so acceptance passes at the broken base. Needs a scaling check before it can be scored.

## Runs

| Agent | Case | Attempt | Verdict | Acceptance | Turns | Cost | Agent time | Files changed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `noop` | `lattice-false-green` | 1 | failed | pass, exit 1, exit 1 | – | n/a | 0.0m | 0 |
| `claude-code-haiku-5-5` | `lattice-false-green` | 1 | verified | pass, pass, pass | 33 | $0.05 | 4.0m | 5 |
| `claude-code-sonnet-5-5` | `lattice-false-green` | 1 | verified | pass, pass, pass | 19 | $0.27 | 1.8m | 11 |
| `claude-code-opus-5-5` | `lattice-false-green` | 1 | verified | pass, pass, pass | 55 | $1.57 | 5.6m | 18 |
| `noop` | `tessera-tcap-binder` | 1 | failed | exit 101, pass | – | n/a | 0.0m | 0 |
| `claude-code-haiku-5-5` | `tessera-tcap-binder` | 1 | verified | pass, pass | 19 | $0.04 | 4.3m | 1 |
| `claude-code-sonnet-5-5` | `tessera-tcap-binder` | 1 | verified | pass, pass | 10 | $0.26 | 2.6m | 1 |
| `claude-code-opus-5-5` | `tessera-tcap-binder` | 1 | verified | pass, pass | 14 | $0.61 | 3.0m | 1 |
| `noop` | `lattice-false-green` | 2 | failed | pass, exit 1, exit 1 | – | n/a | 0.0m | 0 |
| `claude-code-haiku-5-5` | `lattice-false-green` | 2 | verified | pass, pass, pass | 32 | $0.04 | 5.2m | 7 |
| `claude-code-sonnet-5-5` | `lattice-false-green` | 2 | verified | pass, pass, pass | 14 | $0.20 | 1.9m | 11 |
| `noop` | `tessera-tcap-binder` | 2 | failed | exit 101, pass | – | n/a | 0.0m | 0 |
| `noop` | `lattice-false-green` | 3 | failed | pass, exit 1, exit 1 | – | n/a | 0.0m | 0 |
| `noop` | `tessera-tcap-binder` | 3 | failed | exit 101, pass | – | n/a | 0.0m | 0 |
| `claude-code-opus-5-5` | `lattice-false-green` | 2 | verified | pass, pass, pass | 51 | $1.45 | 4.9m | 17 |
| `claude-code-haiku-5-5` | `tessera-tcap-binder` | 2 | verified | pass, pass | 17 | $0.03 | 3.4m | 1 |
| `claude-code-sonnet-5-5` | `tessera-tcap-binder` | 2 | verified | pass, pass | 10 | $0.24 | 2.2m | 2 |
| `claude-code-opus-5-5` | `tessera-tcap-binder` | 2 | verified | pass, pass | 10 | $0.52 | 2.3m | 1 |
| `claude-code-haiku-5-5` | `lattice-false-green` | 3 | verified | pass, pass, pass | 30 | $0.04 | 3.9m | 6 |
| `claude-code-sonnet-5-5` | `lattice-false-green` | 3 | verified | pass, pass, pass | 19 | $0.29 | 1.8m | 11 |
| `claude-code-opus-5-5` | `lattice-false-green` | 3 | verified | pass, pass, pass | 41 | $1.34 | 4.7m | 20 |
| `claude-code-haiku-5-5` | `tessera-tcap-binder` | 3 | verified | pass, pass | 13 | $0.03 | 2.1m | 2 |
| `claude-code-sonnet-5-5` | `tessera-tcap-binder` | 3 | verified | pass, pass | 10 | $0.25 | 2.1m | 1 |
| `claude-code-opus-5-5` | `tessera-tcap-binder` | 3 | verified | pass, pass | 9 | $0.52 | 2.4m | 1 |

## Pinned inputs

- Suite: `dogfood/bench/v1.json` (sha256 `59eeea79bf8d9126`)
- Attempts per agent and case: 3; timeout per command: 30.0m
- `lattice-false-green` v1: sp80808/Lattice @ `ba2b6437c505`, held out: none
- `tessera-tcap-binder` v1: sp80808/Tessera @ `7c82b87374cb`, held out: crates/tessera-tcap/tests/derive.rs
- `noop`: `true`
- `claude-code-haiku-5-5`: Claude Code, model `claude-haiku-5-5`
- `claude-code-sonnet-5-5`: Claude Code, model `claude-sonnet-5-5`
- `claude-code-opus-5-5`: Claude Code, model `claude-opus-5-5`
- Claude Code CLI: 2.1.300 (Claude Code)
- Models seen in transcripts: `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`
- Harness: Lattice @ `c6725ff8a21b`

## Rerun

```bash
npm run dogfood:bench --
```
