# Providers

Lattice separates **generation** from **bounded decision-making** so cheap/local models can handle classification, ranking and uncertainty checks while stronger models are reserved for expensive coding work.

## OpenAI-compatible boundary

The first adapter intentionally targets the OpenAI-compatible Chat Completions wire format rather than one vendor SDK. This makes it usable with hosted APIs and open-source runtimes such as:

- Ollama: https://ollama.com/blog/openai-compatibility
- vLLM: https://docs.vllm.ai/en/latest/serving/online_serving/

This is especially useful for Qwen-family models because Lattice can point the decision provider at a locally served Qwen model without coupling core orchestration to a specific runtime.

Example future configuration shape:

```yaml
models:
  decide:
    provider: openai-compatible
    base_url: http://127.0.0.1:8000/v1
    model: <local-qwen-model>
    role: decision
  code:
    provider: auto
```

## Decision contract

Every bounded decision receives:

- compact state;
- one explicit question;
- finite choices;
- an optional decision mode;
- an explicit `__none__` / unknown choice by default.

The provider returns:

- selected choice ID(s);
- normalized scores when available;
- confidence/entropy when derivable;
- model/provider identity;
- latency and token usage.

Invalid/hallucinated choice IDs are rejected instead of silently accepted.

## Why this is deliberately minimal

The initial adapter uses native `fetch` and no provider SDK. Lattice should add an upstream library when it removes meaningful maintenance burden, but the core interface must remain independent of that dependency.

The next decision-engine experiments should compare:

1. ordinary structured-output Qwen inference;
2. raw-logit / constrained-token scoring where the runtime exposes it;
3. Jev/System-One compatible scoring;
4. random baseline;
5. stronger-model arbitration only when uncertainty requires it.

The benchmark, not preference, decides which backend becomes the default for each decision class.
