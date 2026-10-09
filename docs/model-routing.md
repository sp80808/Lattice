# Decision-assisted, usage-aware generator routing (first slice)

A natural-language Lattice task can use a configured **decision model** to choose
among explicitly configured **generator models** on every proposal call. No new
user-facing model-selection command is required.

This is a first slice of [#76](https://github.com/sp80808/Lattice/issues/76)
and [#86](https://github.com/sp80808/Lattice/issues/86), **not** automatic
provider account discovery or strict whole-run budgeting ([#55](https://github.com/sp80808/Lattice/issues/55)).

## Configure

```json
{
  "models": {
    "decision": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "model": "small-decision-model",
      "maxTokens": 256
    },
    "generatorPool": [
      {
        "id": "local-coder",
        "baseUrl": "http://127.0.0.1:11434/v1",
        "model": "local-code-model",
        "maxTokens": 2048,
        "maxContextTokens": 16384,
        "available": true,
        "remainingRequests": 200,
        "remainingTokens": 200000,
        "inputUsdPerMillion": 0,
        "outputUsdPerMillion": 0
      },
      {
        "id": "remote-coder",
        "baseUrl": "https://your-configured-provider.example/v1",
        "model": "remote-code-model",
        "apiKeyEnv": "REMOTE_MODEL_API_KEY",
        "maxTokens": 4096,
        "maxContextTokens": 65536,
        "remainingRequests": 100,
        "remainingCostUsd": 2.0,
        "inputUsdPerMillion": 0.25,
        "outputUsdPerMillion": 1.0,
        "verifiedSuccessRate": 0.8,
        "verifiedSamples": 50
      }
    ]
  }
}
```

All numbers, capabilities and prices above are **illustrative manual inputs**, not
assertions about real products or available subscription credits. In particular,
a hosted subscription's Chat UI allowance does not imply accessible API quota.
Never commit API keys; `apiKeyEnv` names an environment variable.

The rest of the automatic-mode config still needs `agent` and an independently
checked `verify` command / Tessera witness as documented in configuration.md.
Legacy `model` and `models.generator` remain supported; use the new pool instead
of `models.generator` (the two cannot be combined).

## Selection and evidence

1. Start with explicitly configured endpoints. Disabled models, exhausted
   remaining requests, insufficient estimated token headroom, insufficient
   configured context window and unknown/insufficient priced cost headroom are
   excluded **before** any decision-model call.
2. For multiple eligible candidates, the configured `models.decision ?? model`
   chooses one by bounded ID, using a short task preview, remaining capacity,
   known price and *verifier-labelled* model outcome history. Verified success
   rates are only exposed to the selector when at least 20 examples were
   provided; this is a conservative visibility threshold, **not** a calibration
   or statistical guarantee. The selector cannot add endpoints or permissions.
3. With one eligible model, use it without paying for model selection. If the
   selector returns unknown or an unlisted ID, fail closed.
4. After a provider quota/auth/transient-availability error, disable that
   model for the current run and route to a different eligible endpoint. Other
   errors propagate; don't silently conceal malformed or unsafe outputs.
5. Reserve request count before dispatch. Reconcile reported generator tokens
   and cost afterward. If quota-constrained usage is missing, disable reuse of
   that endpoint instead of charging zero. Selector usage is included in
   aggregated generation usage when completely measurable and preserved
   separately in `routing.selectorUsage`.
6. `candidates.generated` / `candidates.rejected` run events include the
   selected model, prior attempts, eligible set, selection method and selector
   identity/usage. The generator's own model identity remains unchanged.

## Boundaries and follow-ups

- **Quota is not autodiscovered.** Remaining-request/token/USD fields are
  run-start snapshots from the user's configuration. Provider-specific
  429/auth/availability errors trigger failover, not a claim that quota is live.
- **Estimates are not hard budget guarantees.** Approximate input tokens are
  derived from text size and output is capped with `max_tokens`. A provider can
  differ in tokenization, bill in unexpected ways, or omit usage. Neither
  these estimates nor the configured headroom can guarantee total run cost;
  #55 must reserve and reconcile *all* model calls, including selectors,
  retries and coding agents, before strict spend limits can be claimed.
- **Model scores are not authoritative.** Until #21/#49 supply held-out,
  independently verified and stratified outcome estimates, the selector can
  optimize informed preferences, not provably choose the best model.
- No provider catalog/network probing is performed on normal runs. #76 can
  supply catalog metadata and provider-specific quota adapters later,
  respecting user configuration and explicit network permissions.
- Routing is for the proposal generator only in this slice. Candidate decision
  and external coding-agent model selection are still separately configured.
  Neither the router nor selector may bypass normal verification, execution
  permissions, or human review gates.
