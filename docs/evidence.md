# Evidence-first repository grounding

Lattice should ask models to reason over **observations**, not to recreate repository state from memory.

The initial evidence layer follows a deliberately small version of the repository-map idea used by Aider:

1. read the current Git revision when available;
2. list tracked files with Git rather than asking a model what exists;
3. fall back to direct filesystem facts outside Git repositories;
4. run explicit commands without a shell by default;
5. attach command exit status/output as evidence;
6. only then construct the TAP packet supplied to reasoning/decision models.

The first implementation keeps file context shallow. A later TCG/indexing slice can enrich it with tree-sitter, SCIP/LSP, call graphs and dependency/version facts.

## Trust rule

A model statement such as “the tests pass” is not verification.

A command evidence record containing the invoked executable, arguments, exit status and captured output can satisfy a verification requirement.

## Output limits

Command output is capped before it reaches run history or model context. Large logs should later be summarized through deterministic extraction first, then model compression only when necessary.

## Safety boundary

`runCommand` does not use a shell. Model-generated shell strings must not be silently executed. Higher-level agent actions should be converted to structured executable + argument arrays, pass policy/approval checks, and only then enter this layer.

## Tessera witness

With `verify.tessera` (see [configuration.md](configuration.md#tessera-verifier)),
the verifier runs `tsr witness` and Lattice keeps the compiler's own
`tessera.witness/v0` document (Tessera `docs/spec/witness.md`) instead of
scraping terminal text:

- The run log's `tool.completed` event for `tessera.witness`, and each repair
  experiment's `outcome.records`, hold a `lattice.tessera-verification/v0`
  record: the command, exit code, verdict, the witness document verbatim, and
  any `tsr run` case results.
- The TAP gets one `build` evidence record per witness (outcome, `result_id`,
  `tsr` version and commit, diagnostics with phase, code and line:col) and one
  `test` record per case.
- Verdicts map to `pass`, `fail`, `unsupported` and `tool_error`. A document is
  trusted only when its `outcome` matches the exit code and it hashes to its
  own `result_id`; otherwise it is recorded as a `tool_error` with the reason,
  and is not verified evidence.
- `replayRunLog(path)` re-parses every stored document, recomputes `result_id`
  and re-derives the verdict without running `tsr`, so a log can be audited
  later or on another machine.
