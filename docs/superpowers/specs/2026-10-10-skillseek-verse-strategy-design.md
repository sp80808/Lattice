# Specification: SkillSeek Deterministic-First Retrieval and VERSE Harness Optimization

**Date:** 2026-10-10  
**Status:** Approved for Implementation  
**Target:** `@lattice/search`, `@lattice/bench`, `@lattice/core`, `@lattice/runtime`  
**References:**  
- *SkillSeek* (arXiv:2609.38822, 30 Sept 2026): BM25 + small reranker matches/exceeds LLM retrieval loops while reducing cost by 46% ($51.30 to $27.54).
- *VERSE — Verified Self-Evolving Optimizer* (arXiv:2610.02616, 2 Oct 2026): Verified harness optimization with failure replay, draft testing, targeted perturbation, regression audits, achieving 42.3% ID and 37.7% OOD.

---

## 1. Executive Summary

Lattice's core economic advantage is avoiding expensive LLM reasoning loops when deterministic computation or small edge models suffice. Recent research validates two vital strategic refinements:

1. **Skill & Capability Retrieval (SkillSeek):**
   Instead of querying decision models (Tev1 0.8B, Qwen 1.7B, or hosted models) for every tool or skill selection, Lattice adopts a **deterministic-first** retrieval pipeline using BM25 and lightweight rankers. It only escalates to a decision model when relevance margins, capability risk, or compatibility remain ambiguous.

2. **Recursive Harness Optimization (VERSE):**
   Agent harness self-improvement cannot rely on speculative model-generated changes. Lattice implements a **reproducibly verified optimizer** that combines:
   - Historical failure replay.
   - Draft candidate execution and targeted perturbation.
   - Strict regression audits across held-out in-distribution (ID) and out-of-distribution (OOD) benchmark tasks.
   - Meta-optimization (tracking efficacy of optimizer mutation operators).

---

## 2. Component 1: Deterministic-First Skill & Capability Retrieval

### 2.1 Principles
- **BM25 Base:** Tools and skills are indexed by identifier, name, description, parameters, and tag keywords.
- **Cost Minimization:** Zero LLM tokens spent for obvious/exact matches (e.g., "run tests", "read file", "git diff").
- **Gated Escalation:** Decision models (Tev1/Qwen) are called only if:
  1. Top-1 BM25 score is below confidence threshold $\tau_{\text{conf}}$.
  2. Margin between top-1 and top-2 scores is below $\Delta_{\text{margin}}$ (ambiguity).
  3. Action requires high-risk capability (e.g. destructive fs/git mutation, external network egress).

### 2.2 Pipeline
```text
Task / Intent / Query
       ↓
Tokenize & Normalize
       ↓
BM25 Inverted Index Match
       ↓
Lightweight Reranker (Score & Margin Calculation)
       ↓
Score >= Tau AND Margin >= Delta AND Not High-Risk?
   ├─ YES ──> Deterministic Resolution (0 model tokens, <1ms)
   └─ NO  ──> Compile DecisionFrame (Shortlisted Top-K)
               ↓
              Invoke DecisionProvider (Tev1 / Qwen3)
               ↓
              Audit Confidence / Entropy / Fallback
```

### 2.3 Data Structures (`@lattice/search`)

```typescript
export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  riskLevel: "low" | "medium" | "high";
  parameters?: Record<string, unknown>;
}

export interface SkillRetrievalResult {
  selectedSkillId: string;
  source: "deterministic" | "model-escalated";
  score: number;
  margin: number;
  candidates: Array<{ id: string; score: number }>;
  modelDecision?: DecisionResult;
}
```

---

## 3. Component 2: VERSE Verified Self-Evolving Optimizer

### 3.1 Principles
- **No Plausibility-Based Accepts:** A harness or prompt change that "sounds cleaner" is rejected unless it yields strictly superior or equal verified task completions.
- **Failure Replay:** Every candidate harness change is evaluated first against known historical failure cases to see if it fixes targeted defects.
- **Targeted Perturbation:** Systematic parameter/policy perturbations (e.g., prompt compaction, confidence thresholds, top-k sampling) rather than unconstrained arbitrary rewrites.
- **Regression Audits:** Candidates that fix historical failures must execute across the baseline regression test suite with 0 regressions.
- **Optimizer-Level Meta-Optimization:** The optimizer records which perturbation types generated verified improvements, tuning operator weights over successive runs.

### 3.2 VERSE Optimization Cycle
```text
1. Select Target Failure Set (from Ledger / Bench history)
2. Generate Targeted Candidate Perturbation (policy, prompt framing, thresholds)
3. Draft Testing (Execute candidate on failure replay tasks in sandbox)
     └─ Did candidate resolve at least 1 failure without crashing?
         ├─ NO  ──> Reject draft, log failure reason
         └─ YES ──> Proceed to Regression Audit
4. Regression Audit (Run candidate across held-out verification suite)
     └─ Pass rate >= baseline AND 0 regressions on previously passing tasks?
         ├─ NO  ──> Reject candidate, rollback harness
         └─ YES ──> Accept & Promote candidate configuration
5. Meta-Optimizer Update (Reward mutation operator, log audit proof to Ledger)
```

### 3.3 Verification Interfaces (`@lattice/bench` / `@lattice/rsi`)

```typescript
export interface VerseDraftCandidate<T = unknown> {
  id: string;
  operator: "prompt-compaction" | "threshold-tuning" | "candidate-ordering" | "context-pruning";
  patch: T;
  hypothesis: string;
}

export interface VerseAuditResult {
  candidateId: string;
  promoted: boolean;
  replayedFailures: { total: number; resolved: number };
  regressionSuite: { total: number; passed: number; regressions: number };
  baselinePassRate: number;
  candidatePassRate: number;
  rejectionReason?: string;
}
```

---

## 4. Implementation Steps

1. **Specs & Documentation Updates:**
   - Update `docs/architecture.md` (decision loop & model router).
   - Update `docs/search-policy.md` (deterministic-first skill retrieval & VERSE gates).
2. **`@lattice/search` Module:**
   - Implement `Bm25SkillRetriever` (BM25 tokenization, term frequencies, inverse document frequencies, scoring).
   - Implement `SkillRetrievalEngine` with deterministic shortlisting and escalation to `DecisionProvider`.
   - Unit tests covering deterministic hits, ambiguous tie escalations, and high-risk flags.
3. **`@lattice/bench` / VERSE Verification Harness:**
   - Implement `VerseOptimizer` with failure replay, draft testing, targeted perturbation, and regression audit.
   - Unit tests validating rejection of regressions, promotion of verified improvements, and operator attribution.
4. **Verification & Regression:**
   - Run complete test suite `pnpm test` ensuring zero breakage.
