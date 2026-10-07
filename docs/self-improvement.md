# Self-improvement flywheel

Lattice should improve by reducing **model calls per verified patch**, not by trusting model self-assessment.

The evidence ledger is the training set, Tessera-style compact context/TAP representations are the memory substrate, and replay is the safety mechanism.

```text
RUN
 ↓
EVIDENCE LEDGER
 task · repo SHA · frame hash · decision class · choices · scores
 provider/model · tokens · cost · tool evidence · patch · verification
 ↓
 ├─ L1 CALIBRATE   provider/router reliability
 ├─ L2 CONSOLIDATE deterministic rules + Tessera CTX tiles
 ├─ L3 COMPRESS    TAP/TCG/TMT context shrinkage
 └─ L4 POLICY      offline replay / held-out policy search
 ↓
NEXT RUN: fewer calls, less context, better routing
```

## Reward invariant

Only objective verification may serve as success/reward.

Model claims, agent exit codes, confidence and human preference are useful metadata but are not correctness labels.

Primary optimization target:

```text
verified patches / unit cost
```

with secondary constraints on latency, regressions, human interruptions and context size.

## L1 — Calibrate

Decision events must retain:

- decision class;
- frame/question hash;
- exact option set;
- provider/model/version;
- score distribution;
- confidence/entropy;
- token/cost/latency usage;
- human override/refinement state;
- downstream objective verification outcome.

Use this to estimate reliability/calibration per provider × decision class and eventually route decisions as a contextual bandit.

First deliverable: `lattice stats` over run JSONL.

Do not auto-update routing weights until there is enough held-out evidence.

## L2 — Consolidate

### Rule mining

Repeated, high-margin, objectively validated decisions may be proposed as deterministic rules.

Rule promotion requirements:

1. minimum support count;
2. reproducible evidence links;
3. zero or bounded error on training history;
4. no regression on held-out replay;
5. human-reviewable PR.

Headline metric: percentage of decisions resolved without a model call.

### Failure/fix memory

Verified failure → intervention → verification pairs become compact context tiles.

Target Tessera-style semantics:

```text
scope + condition + recommendation/avoidance + why/evidence + freshness
```

Trust lifecycle:

```text
observed → inferred → verified → trusted
                           ↘ stale / revoked
```

No mined tile silently becomes trusted.

First consumer: Tessera repair memory (`packages/tessera/src/memory.ts`,
`compare.mjs --record-memory/--memory`). Pairs enter only once `tsr` verified
the fix, are shown to the generator as worked examples rather than applied
as rules, are never retrieved for the task they came from, and are used only
when a run opts in; `examples/tessera-repair/heldout/` measures them on tasks
the memory was not built from.

## L3 — Compress

Compression targets, in order of frequency:

1. TAP decision packets;
2. repository context/TCG slices;
3. diagnostics/tool output;
4. subagent return packets;
5. replay/event summaries.

Requirements:

- reversible expansion for semantic state;
- canonical hashes remain stable across equivalent encodings;
- compression benchmarked against task success;
- canonical source is never destructively rewritten by lossy compression.

Tessera TMT/TC/TIR can progressively replace provisional JSON/text boundaries without changing the orchestration APIs.

Metrics:

- TAP bytes per decision;
- context tokens per model call;
- context rebuild time;
- verified success at equal context budget.

## L4 — Offline policy search

Never tune orchestration thresholds by experimenting blindly on live repositories when replay can answer the question first.

Candidate policies include:

- confidence/entropy escalation thresholds;
- top-k;
- parallelism;
- provider routing;
- question-refinement thresholds;
- when to request human review;
- context budget;
- maximum search rounds.

`lattice policy-sim candidate.json --against <runs>` should compare the candidate with the recorded policy.

Split historical tasks into:

- optimization/training slice;
- held-out evaluation slice;
- frozen recurring benchmark slice.

A policy is promotable only when held-out verified success does not regress beyond configured tolerance and cost/latency improves.

## Self-modification boundary

Lattice may **propose** changes to:

- router tables/weights;
- deterministic rules;
- CTX memory tiles;
- search/autonomy policy files;
- compression configuration.

All proposals are repository artifacts and ship through normal PR review.

Runtime code, tests and verification policy are not silently self-modified.

## Near-term optimizations

- batch/rank multiple choices in one decision call;
- top-k parallel experiments with bounded concurrency;
- stop launching queued work after verified success;
- content-addressed context cache;
- decision memoization by frame hash + repo SHA;
- local logit/constrained-choice scoring;
- deterministic output extraction before model summarization;
- incremental TCG invalidation;
- WASM TC↔TIR/TMT codec when Tessera runtime is ready.

## Demonstration

Run a fixed benchmark suite against Lattice and Tessera regularly and publish:

- verified patches;
- cost per verified patch;
- model calls per verified patch;
- context tokens per verified patch;
- deterministic-rule coverage;
- human-review frequency;
- regression rate;
- latency.

The expected learning curve is downward cost/model-call/context usage at stable or improving verified success.
