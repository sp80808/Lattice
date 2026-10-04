# Runtime configuration

Lattice's default user-facing configuration is intentionally small.

A project can place this at `.lattice/config.json`:

```json
{
  "mode": "auto",
  "model": {
    "provider": "openai-compatible",
    "baseUrl": "http://127.0.0.1:11434/v1",
    "model": "qwen3-coder"
  },
  "agent": {
    "preset": "qwen-code",
    "approvalMode": "auto-edit",
    "outputFormat": "json"
  },
  "verify": {
    "command": "npm",
    "args": ["test"],
    "timeoutMs": 120000
  },
  "search": {
    "maxRounds": 4,
    "candidatesPerRound": 4
  }
}
```

Then:

```bash
lattice "fix the failing parser tests"
```

The CLI composes the existing layers automatically:

```text
OpenAI-compatible Qwen endpoint
      ├─ proposal generator
      └─ bounded decision provider
               ↓
       evidence search loop
               ↓
      Qwen Code child agent
               ↓
       isolated Git worktree
               ↓
            npm test
```

## Tessera verifier

For a Tessera program, `verify.tessera` runs the real `tsr witness` instead of a
shell command and stores its `tessera.witness/v0` JSON in the run log:

```json
{
  "verify": {
    "tessera": {
      "tsr": "/path/to/tsr",
      "file": "add.tes",
      "phase": "check",
      "overflow": "trapping",
      "cases": [{ "function": "add", "args": [2, 3], "expect": "5" }]
    }
  }
}
```

- `tsr` defaults to `$TSR`, then `tsr` on `PATH`.
- `phase` is `check` (default), `mir` (needs `overflow`) or `backend`
  (reported `unsupported`, never faked).
- `cases` run only when the witness passes, through `tsr run`; they need
  `overflow` because `tsr run` has no default.
- The verdict comes from the document's `outcome` and the exit code, and the
  document must hash to its own `result_id`; anything else is a tool error.
  `replayRunLog()` in `@lattice/tessera` re-derives every stored verdict from a
  run log without running `tsr`. See [evidence.md](evidence.md#tessera-witness).

## Random decision baseline

`models.decision: { "provider": "random", "seed": 1 }` keeps the configured
generator but picks uniformly among its candidates (never "none"). Use it to
measure what a decision model adds (`docs/mvp.md` Milestone C).

## Configuration discovery

In order:

1. explicit `lattice --config <path> ...`;
2. `LATTICE_CONFIG`;
3. `.lattice/config.json`;
4. `lattice.config.json`.

## Modes

### auto

Requires:
- decision/generator model configuration;
- coding-agent preset;
- objective verifier.

Lattice refuses to enter automatic coding search without a verifier.

### observe

Builds repository evidence and may run the configured verification command, but does not invoke model search or a coding worker.

## Model endpoints

The first runtime configuration targets an OpenAI-compatible endpoint because Ollama, vLLM and many hosted/local model servers expose this shape.

One `model` block supplies both proposal and decision roles for minimal configuration. Advanced configuration can separate them:

```json
{
  "models": {
    "decision": {
      "baseUrl": "http://127.0.0.1:8000/v1",
      "model": "small-qwen"
    },
    "generator": {
      "baseUrl": "http://127.0.0.1:8001/v1",
      "model": "coder-model"
    }
  }
}
```

API keys should be referenced through environment variables rather than stored in the repo:

```json
{
  "model": {
    "baseUrl": "https://example.invalid/v1",
    "model": "model-name",
    "apiKeyEnv": "MY_MODEL_API_KEY"
  }
}
```

## Agent presets

Current:
- `qwen-code`
- `opencode`

They are thin wrappers over the generic process adapter.

## Safety

Verification is expressed as an executable plus an argument array. It is not interpreted through a shell.

The config parser does not accept model-generated commands. Automatic mutation still happens in isolated worktrees, and successful candidates remain untrusted until the verifier passes.


## Autonomy and human-in-the-loop

```json
{
  "autonomy": {
    "mode": "supervised",
    "minConfidence": 0.72,
    "maxNormalizedEntropy": 0.72,
    "reviewHighCost": true,
    "reviewQuestionWarnings": true
  },
  "search": {
    "candidatesPerRound": 5,
    "topK": 1,
    "parallelism": 1
  }
}
```

Modes:

- `autopilot`: proceed without routine human review after framing checks.
- `supervised`: review low-confidence/high-entropy/high-cost or framing-warning decisions.
- `manual`: review every bounded decision.

The CLI provides the review surface when attached to a TTY. A required review in a non-interactive environment blocks instead of being auto-approved.

For deliberate best-of-N search:

```json
{
  "search": {
    "candidatesPerRound": 6,
    "topK": 2,
    "parallelism": 2
  }
}
```

This keeps parallelism explicit and benchmarkable rather than silently multiplying agent cost.
