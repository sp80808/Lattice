# Decision benchmark reanalysis — 2026-10-10

The saved predictions support a narrower conclusion than the original reports:
Tev1 0.8B performs best on this synthetic corpus, while outages explain part of
Qwen's and Tev1 4B's lower aggregate scores. These measurements do not establish
whole-task coding success or justify a model/policy promotion.

Source: ten prediction JSONL files from the sibling
`../benchmarks/results/decision-bench-20261010*.jsonl` directory. All were replayed
offline; no new model or Colab requests were made. The
[machine-readable reanalysis](../../benchmarks/results/decision-reanalysis-20261010.json)
records each source path and SHA-256, the reference corpus hash and the harness
hash. Originals were preserved. Legacy prompt hashes and execution plans were
not recorded, so corpus matching verifies labels and metadata only.

| Saved run | Attempted | Correct | Request errors | Accuracy including failures | Accuracy on valid responses | Valid-response Wilson 95% CI | Median latency |
|---|---:|---:|---:|---:|---:|---|---:|
| Tev1 0.8B SystemOne, 17:50 UTC | 110 | 96 | 0 | 87.3% | 87.3% | 79.8–92.3% | 129.5 ms |
| Qwen3 1.7B chat, 17:41 UTC | 110 | 41 | 37 | 37.3% | 56.2% of 73 | 44.8–66.9% | 3634.1 ms |
| Tev1 4B SystemOne, 18:37 UTC | 110 | 69 | 13 | 62.7% | 71.1% of 97 | 61.5–79.2% | 936.0 ms |
| Laya SystemOne, 18:37 UTC | 110 | 55 | 0 | 50.0% | 50.0% | 40.8–59.2% | 57.1 ms |

Latencies include failed requests. Removing failures produces a diagnostic
conditional accuracy, with selection bias; it does not recover the answers
that failed requests would have returned. No invalid model responses were
identified in these legacy rows, but their retained fields cannot establish
compliance with the stricter response validation added to the harness.

## Failures and paired evidence

The Qwen 17:41 run has one connection closure and 36 refused connections.
The same timestamp's Tev1 run has 110 refused connections and no decision
accuracy to estimate. Two 17:40 runs each contain 84 unsupported-protocol HTTP
400 errors: Qwen was called through SystemOne and Tev1 through chat. They measure
endpoint incompatibility rather than routing quality.

The 4B run has 13 HTTP 500 errors from the MLX Metal compiler service.
On the 97 cases with valid 4B replies, the 0.8B model answered 84 correctly
(86.6%) versus 69 (71.1%) for 4B. There are 19 cases only 0.8B gets right and
four only 4B gets right. On all 110 Laya cases, 0.8B scores 96 versus Laya's 55;
43 cases favor only 0.8B and two favor only Laya. These comparisons control case
identity, but endpoint snapshots, prompts and model builds lack historical
hashes. They are descriptive comparisons rather than a controlled causal trial.

The earlier completed 84-case Qwen run scored 48/84 (57.1%), consistent with the
later run's 41/73 conditional score. The six-case smoke run is too small to
establish a ranking. The 84-case and 110-case scores use different case sets
and should not be treated as a measured regression.

## Limits affecting the next experiment

All 240 corpus cases append the same generic claim that the implementation and
failing test were inspected and that no edits are pending. This contradicts
families that explicitly describe missing evidence, missing reproduction,
unverified edits or no task. Results on those families confound routing with
contradictory input. The corpus was preserved to keep historical data readable;
correcting it requires a new version and fresh baselines.

Train and holdout subjects are disjoint, but all 13 family templates appear in
both splits. This tests transfer to different subject names, not unseen reasoning
templates or real repository tasks. Tev1 0.8B's ambiguous family remains 0/9,
and its data-loss family is 4/7. Its low mean confidence (0.2848) despite high
accuracy also means a raw confidence threshold cannot be assumed calibrated.

The saved LoRA smoke artifact used 16 training samples and six test samples,
improving from two to three correct answers. That is insufficient evidence for
adapter promotion and is separate from the 110-case routing corpus.

The next comparable experiment needs consistent per-family evidence in a
versioned corpus, template-disjoint evaluation, working endpoints and whole-task
verification alongside the choice benchmark. No live rerun or promotion was
performed in this reanalysis.
