// Regression tests for the example checker's own integrity (issue #38).
//
// Each test breaks one step on purpose by putting a `node` shim first on PATH
// that fails when it sees a chosen argument and runs the real node otherwise.
// Nothing in the scripts under test knows about the shim.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

function runWithBrokenNode(script, args, breakOn) {
  const dir = mkdtempSync(join(tmpdir(), "lattice-broken-node-"));
  try {
    const shim = join(dir, "node");
    writeFileSync(
      shim,
      `#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in *${JSON.stringify(breakOn)}*) echo "broken on purpose: $arg" >&2; exit 7 ;; esac
done
exec ${JSON.stringify(process.execPath)} "$@"
`,
    );
    chmodSync(shim, 0o755);
    return spawnSync(script, args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("check-examples exits non-zero and never claims success when an example fails", () => {
  const result = runWithBrokenNode(join(root, "scripts/check-examples.sh"), [], "examples/embedded/offline-search-loop.mjs");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /broken on purpose/);
  assert.doesNotMatch(result.stdout, /All examples passed/);
  assert.doesNotMatch(result.stdout, /search solved by test evidence/);
});

test("run-demo --strict fails when the lattice run fails", () => {
  // The CLI is invoked as `node apps/cli/dist/index.js -C <dir> <task>`; break only the run step.
  const result = runWithBrokenNode(join(root, "examples/demo/run-demo.sh"), ["--strict"], "fix the failing add test");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /error:(\x1b\[0m)? run failed/);
});
