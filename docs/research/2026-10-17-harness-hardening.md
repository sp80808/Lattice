# Harness hardening: verified change sets and the next reliability slice

Date: 2026-10-17
Status: first slice implemented on `arena/568c92a6-lattice`; backlog below is not implemented.

## Why this slice

Issue #78 freezes feature work behind the Stage 0 floor: safe, recoverable,
verified workspace mutation before context compression or UI work. The
previous slice (#79) reduced worker capabilities (minimal environment,
process-tree reaping, shared-ref tamper detection). The remaining gap on the
same floor was #54: the bytes Lattice reviewed were not necessarily the bytes
it verified, and they were not necessarily the bytes promotion committed.

The implemented change closes that gap and several adjacent integrity holes
that are cheap to enforce without a sandbox backend:

- Complete, NUL-safe change-set manifest with full-byte and mode identity.
- Untracked files are content-addressed, not just listed by name.
- Symlink, submodule, unmerged, oversized and path-escape policy.
- Verification bound to the manifest digest; verifier mutations become drift.
- Worktree Git wiring and `HEAD` movement detected after the worker.
- Promotion resets the index, stages exactly the manifest, disables hooks,
  and re-checks the staged and committed trees.
- Structured verifier successes are now promotable (previously only command
  verifiers were accepted by `promoteVerifiedRun`).

This is detection and fail-closed staging, not OS isolation. A worker still
runs as the user's OS identity; #52 remains the P0 for confinement.

## Backlog, ordered by expected verified-success gain per unit of risk

| # | Idea | Why it matters | Cost / dependency | Status |
|---|---|---|---|---|
| 1 | Verifier isolation: run the authoritative oracle from an immutable snapshot, not the mutable worktree | A worker can edit the code the verifier tests; drift detection catches late writes but cannot stop a verifier that trusts attacker-written helpers | Needs a read-only checkout or copy; coordinate #49 and #52 §9 | next |
| 2 | Sandbox backend contract with declared capabilities | Makes "isolated worktree" mean source isolation and names the actual OS guarantees; records backend/version in run provenance | Interface plus one native backend; benchmark against current runner | proposed |
| 3 | Network egress policy and package/install mediation | Repository text can induce installs; deterministic pre-install checks (source, lockfile, lifecycle scripts, registry config) are cheaper than model security prompts | Static manifest diff plus policy evidence; no proxy yet | proposed |
| 4 | Resource caps: process count, CPU, memory, disk bytes | Current caps bound Lattice's log, not the host; a worker can fill disk | Needs sandbox or cgroup/rlimit integration | blocked on #2 |
| 5 | Untrusted-content provenance in prompts | Mark user task as instruction authority, repository/docs/issues as data; do not auto-promote repo-local agent rules | Prompt envelope + adapter capability manifest; changes model behavior, needs ablation | proposed |
| 6 | Durable checkpoints keyed by `changeSetDigest` | The manifest is a natural checkpoint ID; enables resume, selective undo and replay without trusting worktree paths | Storage/GC policy; coordinate #67 and #71 | proposed |
| 7 | Retained-artifact store with digest-addressed blobs | Lets a cleaned worktree keep the exact reviewed bytes (currently only a bounded patch survives) | Content-addressed store, size quotas, GC | proposed |
| 8 | Sibling experiment evidence isolation | #56: one executor error should not discard other candidates' evidence | Draft work exists (PR #65); rebase on the manifest type | draft |
| 9 | Enforceable token/cost budgets | #55: budgets are metadata today; stop rather than overshoot | Requires provider usage normalization and an abort path; coordinate #76 | proposed |
| 10 | Policy/verifier drift telemetry | Count policy violations and untrusted verification per adapter; a nonzero rate is false-green caught. Useful as a harness quality metric in #69 | Aggregate existing run events; no model work | proposed |

## Rejected or deferred

- **Model review as a promotion gate.** A second model opinion is useful
  evidence but is not objective verification under the reward invariant.
- **Allowlists for symlinks that leave the worktree.** Allowing an external
  target would make later reads environment-dependent; only in-worktree
  targets are permitted even under `symlinks: "allow"`.
- **Capturing identity from the Git index.** The index is mutable by the
  worker and changes when promotion stages the same bytes. The manifest is
  worktree-based; promotion resets the index and proves the staged tree
  matches.
- **Rename detection as identity.** Similarity heuristics change when the
  index starts seeing new paths. Renames are represented as delete plus add,
  which is stable before and after staging.

## Acceptance observed

The agents suite now covers: untracked/binary/executable capture, unicode and
newline filenames, symlink containment, outside-directory replacement,
entry-limit truncation, digest drift, verifier mutation, verifier-created
files, late edits, late files, staged phantoms, structured-verifier
promotion, worker commits, `.git` rewrites, and byte-exact binary promotion.
All Node suites pass with the CI allowlist (`LATTICE_TEST_ALLOWLIST=scripts/test-allowlist-node-ci.json`).

Next measurement: run the dogfood corpus with the manifest enabled and record
how many previously "verified" patches are now rejected for drift or policy.
That count is the immediate estimate of false-green exposure.
