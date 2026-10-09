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

The decision state currently includes only:

- task;
- constraints;
- recent evidence;
- unresolved uncertainties.

This is intentionally small. TCG will later replace the simple state packer with graph-selected context under a token budget.

## Stopping

The loop stops when:

- an executor returns verified terminal success;
- the decision model selects unknown/none;
- the round budget is exhausted.

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


## Contextual decision / question routing (first slice)

The user supplies a natural-language task, **not** a `choice`, `score` or `noul` CLI command. Question primitives are private implementation details of the decision-provider contract. A typed SDK/MCP adapter may still expose low-level operations to external developers, but the default user workflow is a single task goal.

Current first slice: `routeContextualQuestion(TAP, candidates, topK)` deterministically classifies the *question to ask* without a separate LLM call:

| Live context | Question intent | Provider primitive |
|---|---|---|
| No verified evidence | Which step would establish the missing facts? | internal choice/rank |
| Only diagnostic probes | Which investigation is most informative? | internal choice/rank |
| Verified evidence and only proposed changes | Which patch should undergo independent verification first? | internal choice/rank |
| Mixed or ambiguous candidate types | Which next action best advances verified progress? | internal choice/rank |

Classification uses coarse keywords in generated candidate action descriptions **only for advisory question framing**. They must never authorize filesystem, shell, secret or network actions; the executor's permission and verifier barriers remain authoritative. Unknown/none remains an available answer. `topK` still controls whether the provider returns one candidate or ranks several; it is *not* a user-facing choice of operation.

The router records the chosen question class, internal mode and routing reason inside the versioned `DecisionFrame` trace. Distinct modes have distinct frame hashes. The objective, constraints and original evidence stay available.

**Still to implement under [#86](https://github.com/sp80808/Lattice/issues/86):** infer when *no model question* is warranted (deterministic facts), choose internal score/binary questions where useful, question-scoped evidence sufficiency, automatic original-context expansion, batching, empirically calibrated abstention and escalation. This first slice does **not** claim compression is accuracy preserving or that provider confidence is a verified probability.

**Evaluation:** compare the old generic question with contextual framing on frozen candidate sets, measuring correct independently verified choices, additional provider calls, downstream successful patches, abstentions, misrouting and overall cost. Keep the generic framing as baseline until measured.

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
