# Offline policy simulation

`lattice policy-sim` evaluates candidate orchestration policy changes against recorded replay history before live adoption.

```bash
lattice policy-sim candidate.json
lattice policy-sim candidate.json --against .lattice/runs archive/runs
lattice policy-sim candidate.json --holdout 0.25 --json
```

Example candidate:

```json
{
  "autonomy": {
    "mode": "supervised",
    "minConfidence": 0.65,
    "maxNormalizedEntropy": 0.75,
    "reviewQuestionWarnings": true,
    "reviewHighCost": true
  },
  "search": {
    "maxRounds": 4,
    "topK": 1,
    "parallelism": 1
  }
}
```

## Supported counterfactuals

The initial simulator can safely replay:

- fewer maximum rounds;
- a smaller top-k subset when those candidates were actually executed;
- autonomy/review thresholds when the required human action exists in history;
- removal of a recorded approval-only review.

It reports resulting verified success, decision calls/tokens, human reviews and experiment counts over comparable runs.

## Explicitly unsupported

The simulator does not invent outcomes for:

- additional rounds after an unsuccessful recorded trajectory;
- top-k expansion into candidates never executed;
- newly requested human reviews with no historical human response;
- removal of a behavior-changing human replace/refine/stop action;
- selected experiments without objective evidence;
- execution-latency changes from different parallelism.

Parallelism may be present in a candidate policy, but current logs do not contain enough per-experiment timing to claim a latency counterfactual.

Future provider/model-routing changes likewise require either historical overlap, randomized exploration data or a stronger off-policy estimator.

## Held-out discipline

Runs are assigned deterministically to train/holdout by hashing run ID. Default holdout is 20%.

Policy promotion should require:

- meaningful held-out coverage;
- no unacceptable verified-success regression;
- improved cost/calls/reviews/latency on supported metrics;
- explicit review of unsupported counterfactuals.

An empty holdout is a warning, not permission to promote.

## Reward discipline

As with calibration, only objective command/test/build/lint/benchmark evidence can support verified success. Model claims and confidence are never reward labels.
