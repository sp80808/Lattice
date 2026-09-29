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
