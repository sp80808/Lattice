# Specification: Colab Compute, Model Fine-Tuning, and Verified Recursive Self-Improvement for Lattice

**Date:** 2026-10-10  
**Status:** Approved for Implementation  
**Target Repositories:** Lattice (`https://github.com/sp80808/Lattice`), Tessera (`https://github.com/sp80808/Tessera`)  
**Branch:** `feat/colab-rsi-pipeline`

---

## 1. Executive Summary

Lattice relies on small, low-cost decision models to orchestrate code search and repair tasks while keeping computational spend minimal. This specification defines a production-grade vertical slice integrating:
1. An official Google Colab CLI backend for hardware acceleration (NVIDIA Tesla T4).
2. A reproducible multi-backend benchmark harness evaluating local Apple Silicon models (Tev1 0.8B, Qwen3 1.7B) alongside cloud-hosted models.
3. Supervised parameter-efficient fine-tuning (LoRA / QLoRA) on verified Lattice task-decision datasets.
4. An evidence-gated Recursive Self-Improvement (RSI) loop that proposes policy calibrations and model adapter weights, strictly gated by independent verification against held-out benchmark tasks.

---

## 2. Core Principles & Constraints

- **Evidence Beats Model Confidence:** No model output or candidate policy is promoted without objective verifier pass status (compiler exit code 0, test pass, witness match).
- **YAGNI & Codebase Reuse:** Maximize reuse of `@lattice/core`, `@lattice/bench`, `@lattice/policy`, `@lattice/mining`, and `@lattice/ledger`.
- **Zero-Cost Default CI:** GitHub Actions CI runs on local CPU using deterministic mocks; Colab execution is strictly opt-in and requires explicit session authorization.
- **Compute Unit (CU) Budget Guarantees:** Ephemeral sessions enforce strict timeouts, resource monitoring via `colab usage`, and pre-execution authorization.
- **Provenance & Reproducibility:** Every benchmark and fine-tuning artifact records dataset hash, git commit SHA, RNG seed, model identifier, and execution environment.

---

## 3. Architecture & Packages

### 3.1. Package Structure
```
packages/
├── colab/                 # Colab CLI wrapper, session manager, and remote runner
│   ├── src/
│   │   ├── client.ts      # Subprocess execution of `colab` CLI
│   │   ├── session.ts     # Lifecycle: new, status, exec, download, stop
│   │   ├── mock.ts        # In-memory mock for zero-credential unit tests & CI
│   │   └── index.ts
│   └── src/index.test.ts
├── bench/                 # Extended with multi-backend evaluation
│   ├── src/
│   │   ├── backend.ts     # Local vs Colab execution interface
│   │   └── ...
├── rsi/                   # Recursive Self-Improvement orchestrator
│   ├── src/
│   │   ├── dataset.ts     # Extracts verified training/eval pairs from ledger/bench
│   │   ├── trainer.ts     # Remote Colab LoRA fine-tuning script dispatch & artifact retrieval
│   │   ├── policy_rsi.ts  # Policy search (thresholds, routing, candidate ordering)
│   │   ├── loop.ts        # Iterative RSI evaluation and promotion gate
│   │   └── index.ts
│   └── src/index.test.ts
```

### 3.2. Colab Runner (`@lattice/colab`)
- Wraps official `colab` CLI (`/Users/user/.local/bin/colab`).
- Supported operations:
  - `colab sessions`: verify active runtime (e.g. `lattice-eval` on T4).
  - `colab exec -s <session> -f <script> / stdin`: execute remote Python scripts.
  - `colab upload` / `colab download`: transfer datasets and model adapter checkpoints.
  - `colab stop -s <session>`: terminate ephemeral sessions.
  - `colab usage`: balance & rate monitoring.
- Provides an automated fallback from GPU session to local execution if Colab is offline or unauthenticated.

### 3.3. Evaluation & Multi-Backend Benchmark
- Evaluates decision tasks from `benchmarks/basic/*` and `benchmarks/tessera/*`.
- Backends supported:
  1. `local-systemone`: Ollama `tev1:0.8b` via `/v1/systemone`.
  2. `local-openai`: Ollama `qwen3:1.7b` via `/v1/chat/completions`.
  3. `colab-t4`: Colab session running PyTorch/Transformers on NVIDIA T4.
  4. `oracle`: Deterministic ground-truth solver baseline.
  5. `random`: Deterministic pseudo-random baseline.
- Metrics recorded per trial:
  - Accuracy (exact choice match)
  - Task resolution rate (verified patch applied)
  - Decision latency (ms)
  - Prompt & completion tokens
  - Cost in USD and Colab compute units (CU)
  - Wilson 95% confidence interval for pass rate

### 3.4. LoRA Fine-Tuning Pipeline
- **Dataset Generation:** Formats decision requests and verified outcomes into instruction-tuning pairs:
  ```json
  {
    "instruction": "Select the single best candidate action to fix the failing test.",
    "input": "State: ... Candidates: [inspect, rewrite, fix-add]",
    "output": "fix-add",
    "verified": true
  }
  ```
- **Remote Training Workflow:**
  1. Generates and validates training dataset split (train vs held-out test).
  2. Uploads dataset to Colab session.
  3. Dispatches Python training script using Hugging Face `transformers` + `peft` (LoRA with r=8, alpha=16 on attention projections).
  4. Downloads trained adapter weights (`adapter_model.safetensors`, `adapter_config.json`) to local `.lattice/adapters/<id>/`.
  5. Preserves GPU memory and verifies training loss convergence.

### 3.5. Evidence-Gated Recursive Self-Improvement (RSI)
- **Cycle:**
  1. Measure immutable baseline on held-out benchmark tasks.
  2. Propose candidate update:
     - **Policy RSI:** Calibrate confidence thresholds, routing priorities, and candidate search order using `@lattice/policy` and `@lattice/mining`.
     - **Weight RSI:** Fine-tune small decision model adapter using validated task evidence.
  3. Evaluate candidate against identical held-out benchmark.
  4. **Promotion Gate:**
     - Candidate MUST achieve higher or equal accuracy and lower or equal cost.
     - Zero regressions on previously passing tasks.
     - Statistically significant improvement (Wilson 95% interval).
  5. If rejected: rollback to baseline, record diagnostic failure reason in evidence ledger.
  6. If accepted: promote candidate to active configuration (`.lattice/config.json`).

---

## 4. CLI Interface Extensions

```bash
# 1. Benchmark across backends
lattice bench --backend local --strategies tev1,qwen3
lattice bench --backend colab --session lattice-eval --strategy colab-t4

# 2. Dataset creation & Fine-tuning
lattice train --source ledger,benchmarks --model Qwen/Qwen2.5-Coder-1.5B --backend colab --session lattice-eval --out .lattice/adapters/v1

# 3. Recursive self-improvement
lattice rsi --mode policy --iterations 3 --out .lattice/rsi-policy-run.json
lattice rsi --mode weight --adapter .lattice/adapters/v1 --gate strict
lattice rsi compare --baseline .lattice/baseline.json --candidate .lattice/candidate.json
```

---

## 5. Verification & Testing Plan

1. **Unit Tests:**
   - `@lattice/colab`: Mocked subprocess interactions, timeout handling, error propagation, JSON parsing.
   - `@lattice/rsi`: Dataset schema validation, split determinism, promotion gate logic, rollback safety.
2. **Integration Smoke Tests:**
   - Local CPU benchmark runs cleanly without Colab credentials.
   - Real Colab execution verified with active session `lattice-eval` (NVIDIA T4).
   - Real local Ollama models (`tev1:0.8b` and `qwen3:1.7b`) benchmarked against verified fixtures.
   - Fine-tuning smoke test executed on Colab T4 and verified with adapter retrieval.
   - Gated RSI loop executed and verified on held-out tasks.
3. **Regression Tests:**
   - Existing 102 unit/integration tests in Lattice continue to pass (`pnpm test`).
