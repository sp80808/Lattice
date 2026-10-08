# Lattice + Tessera viability decision — 2026-10-08

Status: **engineering recommendation / testable hypothesis**, not an empirical proof of superiority.

## Executive decision

For the next six weeks, put approximately **75% of project effort into Lattice** (harness reliability, measurement and a useful coding workflow) and **25% into Tessera** (compiler evidence, grammar/diagnostics, TC/TIR fidelity and comparative generation experiments). Review after a reproducible experiment; do not harden this split into permanent policy.

Rationale:
- Lattice already has CLI/daemon/SDK/MCP, a generate→decide→experiment→verify loop, isolated worktree agents, a replay ledger and a **real `tsr witness` integration**.
- Tessera already has a working narrow TC front-end, TIR/MIR/interpreter, compiler diagnostics and witness evidence. Its complete affine/borrowing semantics, general native backend and broad toolchain remain **unproven**, so it should not be a required dependency for Lattice.
- The two components have a nearer-term shared deliverable: **compiler-guided repair with objective outcomes at lower total cost per verified patch**. Neither a new general-purpose language nor a general-purpose assistant is required to evaluate this.
- Competition among full coding agents is intense. The wedge is trustworthy, replayable, cost-aware orchestration and integrations with existing coding tools, not a feature-parity race.

## What is demonstrated and what is not

| Area | Currently observable | Still needs proof |
|---|---|---|
| Compiler feedback | `tsr witness` emits machine-readable source, diagnostic and artifact evidence; deterministic compiler suggestions are separately attributed | General safety equivalence, broad-language workload applicability |
| Lattice search | Runnable offline search and repair comparisons; worktree/agent foundations | Reproducible real-model win versus simpler baselines on non-trivial held-out tasks |
| Self-dogfood | D2 frozen case manifests in `dogfood/` (#41) | End-to-end isolated historical replay without gold-answer leakage |
| Context optimisation | TAP/TCG interfaces and candidate compression/retrieval designs | Verified task success or net cost reduction, not just fewer raw prompt tokens |
| Autonomy security | #52 active; draft PR #79 narrows worker environment/handles process trees | Actual sandbox/filesystem/network confinement, promotion protections and safe unattended execution |

Do not call draft PRs merged. As checked on 2026-10-08: Lattice #62, #63, #64, #65 and #79 were open draft PRs; #60 was open non-draft; Tessera #48 was open. Recheck immediately before merging or benchmarking.

## Next 10 working sessions: execution order

### A. Stabilize the truthfulness and safety floor (sessions 1–3)

- Review and integrate ready fixes for real witness timeouts (#60), structured verification in parallel (#64), failure isolation (#65), and the repair loop dependency chain (#62→#63); **only merge after CI, conflict and semantics review**.
- Evaluate #79 separately as an initial #52 security slice. A worktree is not a sandbox; until filesystem/network isolation is implemented, prefer supervised/local trusted development over unrestricted autonomous runs.
- Fix #55 token/cost budget enforcement and #54 complete immutable change manifests before advertising budget bounds or safe verified promotion.
- Complete the `dogfood/` execution runner for #41 using frozen base SHAs and hidden human fix revisions, not just validated manifests.

**Gate:** a failure/timeout cannot count as verified; process exit/tool errors cannot erase sibling evidence; no known repeatable false-green; no mutable promotion outside the exact verified diff.

### B. Measure a paired repair baseline (sessions 4–6)

A **small exploratory pilot**, not a statistically powered claim:
- Three existing one-function Tessera repair classes with compiler suggestions **ON/OFF** (track `candidateSource`), plus three frozen real Lattice/Tessera historical cases when runnable.
- Minimum three deterministic seeds per condition. Retain each exact model ID, version, prompt, repo SHA, `tsr` SHA, initial task, verifier, token accounting, and provider configuration.
- Arms: (1) direct single-agent tool loop, (2) Lattice generator + cheapest deterministic selection, (3) Lattice with small-model decision, (4) random selected from identical proposed candidates; add simple repair-only compiler-suggestion path as a separate arm.
- For fair decision comparisons, replay exactly the **same generated candidate sets** in each selection arm. For system comparisons, control equal total budget and count generator + selector + retries + verifier execution.
- Outcomes: externally verified patch success, cost per verified patch, total tokens (including cached-input charges), wall time, calls, retries, tool errors, regression rate, and inconclusive/unknown outcomes. No zero-cost imputation for missing usage.
- Never label an automatic compiler suggestion as a model success. Prevent reading later gold commits, patch descriptions or golden fixtures inside agent workspaces.
- Keep a short fixed pilot to discover failure classes; expand to a larger frozen held-out set and repeated runs before making public superiority claims.

**Gate:** correct evidence ledger + reproducible paired arm results. If Lattice is worse, document precisely where: generation, retrieval, selector, verification overhead, or coordination.

### C. One externally useful pilot and objective product positioning (sessions 7–10)

- Pick **one** representative TypeScript or Rust issue from an existing public/owned repository and freeze a base commit + independent acceptance oracle before development. Do not use issue/PR text containing later fixes as agent context.
- Make Lattice work through a real coding workflow with cheap/default and stronger model paths. Let Tessera contribute *optional* diagnostics/context where relevant, not a dependency.
- Compare against direct Claude Code/OpenCode or equivalent **with matching model, task, tools and budget**; do not confuse a model change for a harness improvement.
- Deliver one inspectable artifact: reproduction, patch, verified results, cost ledger, TAP trace and a clear comparison explaining the tradeoff.

**Gate:** at least one independently verified useful repair on external code; a repeatable and measurable benefit in at least one target niche, or a clearly diagnosed reason it is absent.

## Go / iterate / pause scorecard

These are **decision thresholds proposed for prioritisation**, not observed results:
- **Proceed with productising Lattice** if: no serious security/verification failures; at least equivalent verified success to a direct-agent baseline; demonstrated reduction in fully accounted cost per verified patch *or* meaningful reliability/replay/recovery differentiation across multiple representative tasks. Test with prospective users before claiming market fit.
- **Iterate narrowly** if: benefit only appears on Tessera's toy repairs or deterministic compiler suggestions; preserve the repair-evidence component but avoid generic-agent positioning.
- **Pause ambitious harness features** if: even after removing obvious overhead, generation/decision/search add repeated cost and latency without improving verified results. Keep the evidence/verifier SDK as a possible stand-alone module.
- **Do not gate Lattice on a full Tessera compiler.** Tessera's own advancement is measured separately.

## Scope discipline

**Do now:** safety correctness, real dogfood, matched-model evaluation, schema-aware compiler repair, budget/replay integrity.

**Defer:** heavyweight RAGFlow stack, general-purpose messaging, marketplace, broad browser UI, speculative agents, hosted multi-tenant infrastructure, large-language standard library, complete Cranelift/LLVM optimization stack.

## Current primary research and implications

- [Agent Retrieval Bench (Qin & Xie, July 2026)](https://arxiv.org/abs/2607.24882): no retrieval family dominates; prioritize measured lexical/structural seeds and task-specific abstention over importing a large generic vector stack (#34/#75).
- [SWE-Bench Pro Verified (Zheng et al., September 2026)](https://arxiv.org/abs/2609.08149): task-quality flaws and gold-solution leakage can inflate results; apply #49 leakage and oracle safeguards.
- [CAVEWOMAN (Adeyemi et al., June 2026)](https://arxiv.org/abs/2606.24083): terse **outputs** may reduce cost but compressing user input can worsen cost/accuracy; prefer reversible tool-output views and matched end-to-end accounting (#23/#73).
- [SWE-agent (Yang et al., 2024)](https://arxiv.org/abs/2405.15793): practical agent-computer interface and actionable compiler feedback matter; optimize executable feedback before spawning additional reasoning agents.
- [Grammar Prompting (Wang et al., 2023)](https://arxiv.org/abs/2305.19234): supports evaluating `tsr grammar` + verified compiler suggestions rather than prompting an unfamiliar DSL blindly.

## Companion language decision

See [Tessera research decision](https://github.com/sp80808/Tessera/blob/main/docs/research/2026-10-08-language-viability.md) **after its corresponding PR merges**. Until then the companion proposal is tracked in its PR. Tessera remains a research substrate and useful compiler diagnostic tool, not a prerequisite for Lattice users.

Related: #9 #23 #34 #36 #39 #40 #41 #42 #47 #49 #50 #51 #52 #54 #55 #56 #62 #63 #64 #65 #67 #69 #73 #74 #75 #78.
