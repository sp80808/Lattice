# Calibration analytics

`lattice stats` is the first L1 self-improvement tool.

By default it scans `.lattice/runs`:

```bash
lattice stats
lattice stats --json
lattice stats .lattice/runs archive/runs
```

It groups decisions by decision class and provider/model, then reports decision volume, objective outcome linkage, verified-success rate, tokens, recorded cost, latency and human-review/override counts.

## Label discipline

A model decision is **not** labelled successful because:
- confidence was high;
- the coding agent exited 0;
- the model said the patch worked.

A decision receives an objective outcome label only when the downstream experiment contains tool/test/build/lint/benchmark evidence. Terminal success additionally requires the experiment to report verified terminal success.

Missing outcome linkage remains unknown and is excluded from success-rate denominators.

## Calibration buckets

Confidence is bucketed into deciles. Buckets with no objective labels remain unscored.

Do not treat tiny buckets as reliable calibration estimates. Router-weight automation should define a minimum support threshold and use held-out evaluation before promotion.

## Human signal

Human review, candidate replacement and refinement are tracked separately. Human intervention is context for analysis, not an automatic correctness label.

This distinction is required for later provider bandits, deterministic-rule mining and policy replay.
