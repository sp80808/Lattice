# Source-grounded planning

`lattice plan` uses the configured OpenAI-compatible generator. For example,
pass a config containing only `{"models":{"generator":{"baseUrl":"http://localhost:11434/v1","model":"your-installed-model"}}}`
with `--config`; a coding agent and verifier are unnecessary.

The embedded example uses the same `runTask(..., { plan })` path with an existing
Codex CLI login. Inspect `blockbound-islands.json` before running it: the selected
source excerpts are sent to the authenticated Codex service. It proposes three
islands with Pirate Bay as the first complete slice. Source ranges describe the
October 10, 2026 working tree and should be refreshed after source changes.

```bash
npm run build
node examples/planning/plan-with-codex.mjs --self-test
node examples/planning/plan-with-codex.mjs \
  '/Volumes/Harry/DEV/Games Archive/Blockbound/blockbound' \
  examples/planning/blockbound-islands.json \
  .lattice/blockbound-planning-trial
```

The output directory must not already exist. It receives `plan.md`, `result.json`,
the Lattice run log and raw Codex events. Blockbound is read for source grounding;
the child runs in an empty temporary directory with a read-only sandbox and is
asked to use no tools. The example rejects tool-using or incomplete responses.
Tool-use detection happens after execution: read-only sandboxing does not disable
reads or all tools. Keep the caller-selected output directory outside the target
repository if it must receive no receipt writes. The result identifies the
adapter as `codex-cli`; it does not establish the exact model or CLI version.
Custom generators are trusted code; the core does not sandbox an injected provider.

The HTTP provider enforces the requested output-token limit. The Codex CLI
example has no hard token-cap flag: it requests a concise answer and uses a
three-minute timeout and a 256 KB captured-output limit, reporting actual usage.
Its self-test uses synthetic events and proves the adapter only. A successful
live run still produces unverified advice, requiring source and product review.
