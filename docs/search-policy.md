# Search policy v0

Lattice's first search policy implements the project's core thesis:

```text
verified state
    ↓
generate a few terse candidate actions
    ↓
cheap bounded decision
    ↓
execute one experiment/action
    ↓
attach objective evidence
    ↓
repeat
```

## Why candidates are actions, not answers

The proposal model is not asked to decide what is true. It proposes bounded next actions and states what evidence each action should produce.

The decision model then chooses among those actions. If none are justified, the explicit `__none__` choice blocks the loop instead of forcing a guess.

## Candidate schema

```json
{
  "id": "repro",
  "label": "Minimize failing test",
  "action": "run a minimal reproduction",
  "expectedEvidence": "smallest failing input",
  "estimatedCost": "low"
}
```

The `action` field is descriptive/opaque. The search package never turns model text directly into a shell command. An `ExperimentExecutor` adapter decides how a candidate is carried out and is responsible for policy/approval boundaries.

## Executors

The same loop can later use:

- deterministic repository probes;
- user-approved commands;
- test/benchmark runners;
- isolated git-worktree patch agents;
- Codex/Qwen/OpenCode/ACP child agents;
- external research agents.

## State compression

The decision state packs evidence under a character budget with a fixed
priority: verified evidence first (an objective result outranks a model
assertion), then recent unverified records, oldest dropped first. Dropped
records are reported as `EVIDENCE_OMITTED:n` so the decision model knows its
context is lossy, and uncertainties are capped with an omission note. Claude
Code runs a five-layer compaction pipeline and OpenHands condenses conversation
history; Lattice's equivalent is this priority packer plus the append-only
event log, which remains the uncompressed canonical source. TCG will later
replace the packer with graph-selected context under the same budget contract.

## Stopping

The loop stops when:

- an executor returns verified terminal success;
- the decision model selects unknown/none;
- the round budget is exhausted;
- a spend budget (tokens, cost or wall time) is exhausted — the loop records
  the spend and the exceeded limit and returns `budget_exhausted`;
- the caller's `AbortSignal` fires, before the next model call or experiment.

Later policies can add beam search, pairwise tournaments, information-gain scoring and parallel top-k execution without changing provider/executor contracts.


## Decision framing and question compiler

Lattice does not send raw generated options directly to Jev/Qwen.

Each decision is compiled into a **DecisionFrame** containing:

- objective;
- decision class;
- neutral question;
- explicit decision criteria;
- compact evidence-grounded state;
- evidence handles;
- finite options;
- explicit insufficient-evidence / none option;
- deterministic framing audit.

The audit checks for missing verified evidence, overly large option sets, substantially duplicated options, leading wording, missing unknown/none, and oversized state. Hard framing errors block the decision. Warnings are visible to the autonomy policy.

This matters because a cheap decision model can only be as reliable as the question it receives. The ledger records the exact frame ID, class, question, provider/model, scores, confidence, entropy, latency and token usage so future calibration can distinguish model quality from question quality.

## Autonomy modes

### autopilot

No routine human review. Framing errors still block, objective verification is still mandatory, and unknown/none remains available.

Use for low-risk, well-tested tasks or controlled benchmark/autofix runs.

### supervised

Human review is requested when the policy detects one or more triggers:

- confidence below threshold;
- normalized decision entropy above threshold;
- framing-audit warnings;
- high-cost selected action.

Thresholds are configurable. If no interactive reviewer is available, Lattice blocks rather than silently escalating autonomy.

### manual

Every model decision is shown to the human before execution. The reviewer can:

- approve the model selection;
- replace it with other candidate IDs;
- ask the generator to refine the option set;
- stop the run.

Human overrides and notes enter the replay log/context, making them future training/calibration data rather than invisible UI state.

## Parallel top-k

`topK > 1` asks the decision provider to rank candidates and executes the selected shortlist with bounded parallelism. It is opt-in because it trades additional compute for latency/diversity. Serial top-1 remains the low-cost baseline.

## Deterministic-first capability retrieval (SkillSeek)

Skill retrieval is deterministic-first and model-assisted only when uncertain:

1. **BM25 index:** Tools and skills are indexed over identifier, label, action, and expected evidence keywords.
2. **Fast scoring:** Zero LLM calls are made for routine, obvious matches where top-1 score and margin exceed configured thresholds ($\tau_{\text{conf}}$ and $\Delta_{\text{margin}}$).
3. **Escalation gate:** The search loop compiles a `DecisionFrame` and consults the decision provider (e.g. Tev1 0.8B or Qwen 1.7B) only when:
   - BM25 top score is below confidence threshold;
   - Margin between top-1 and runner-up is tight (ambiguous intent);
   - The capability carries high risk (destructive fs/git or network operations).

This reduces decision spend and eliminates redundant model invocations.

## Harness recursive optimization and verification (VERSE)

The recursive harness optimizer follows VERSE (Verified Self-Evolving Optimizer):

1. **Failure replay:** Candidate modifications to harness prompts, policies, or parameters are replayed against historical failures to verify targeted defect resolution.
2. **Draft testing & targeted perturbation:** Candidate drafts undergo targeted parameter perturbation instead of arbitrary unconstrained rewrites.
3. **Strict regression audits:** Before any candidate harness is promoted, it must run against the held-out regression suite and produce zero regressions on previously passing tasks.
4. **Meta-optimization:** The optimizer measures the yield of individual mutation operators and optimizes the optimizer's search distribution.
