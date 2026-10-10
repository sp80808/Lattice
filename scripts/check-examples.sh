#!/usr/bin/env bash
# Run every offline example and validate every example config. Used by CI.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

require_node
require_built_cli
cd "$LATTICE_ROOT"

info "Validating examples/configs/*.json"
node --input-type=module -e '
  import { readdirSync, readFileSync } from "node:fs";
  import { parseLatticeConfig } from "@lattice/runtime";
  for (const name of readdirSync("examples/configs").filter((f) => f.endsWith(".json") && !f.startsWith("."))) {
    parseLatticeConfig(JSON.parse(readFileSync(`examples/configs/${name}`, "utf8")));
    console.log(`  ✓ ${name}`);
  }
'

info "examples/embedded/offline-search-loop.mjs"
node examples/embedded/offline-search-loop.mjs >/dev/null; ok "search solved by test evidence"

info "examples/planning/plan-with-codex.mjs --self-test"
node examples/planning/plan-with-codex.mjs --self-test

info "examples/sdk/typescript/run-and-inspect.mjs"
env -u LATTICE_URL node examples/sdk/typescript/run-and-inspect.mjs >/dev/null; ok "TypeScript SDK round-trip"

info "examples/review/remote-reviewer.mjs"
node examples/review/remote-reviewer.mjs >/dev/null; ok "remote review of an auto-mode run"

info "examples/mcp/raw-session.mjs"
node examples/mcp/raw-session.mjs >/dev/null; ok "MCP stdio session"

info "examples/demo/run-demo.sh"
examples/demo/run-demo.sh --strict >/dev/null; ok "CLI walkthrough"

if [ -n "${TSR:-}" ] || has tsr; then
  info "examples/tessera-repair/compare.mjs"
  out=$(node examples/tessera-repair/compare.mjs --seeds 1 2>&1) || { echo "$out"; exit 1; }
  ok "Tessera repair judged by tsr witness"
else
  # CI runs this example in the tessera-witness job, which builds tsr.
  warn "tsr not found (set TSR); skipping the Tessera repair example"
fi

if has python3; then
  info "examples/sdk/python/run_and_inspect.py"
  env -u LATTICE_URL python3 examples/sdk/python/run_and_inspect.py >/dev/null; ok "Python SDK round-trip"
elif [ -n "${CI:-}" ]; then
  die "python3 not found; CI must run the Python SDK example"
else
  warn "python3 not found; skipping the Python SDK example"
fi

info "All examples passed"
