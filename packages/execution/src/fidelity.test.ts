import test from "node:test";
import assert from "node:assert/strict";
import {
  auditArgumentFidelity,
  verifyExecutionFidelity,
  createFidelityPreservingCommand,
} from "./fidelity.js";

test("auditArgumentFidelity flags shell metacharacters and unquoted path spaces", () => {
  const report = auditArgumentFidelity({
    tool: "shell",
    args: ["cat", "foo.txt; rm -rf /", "/path with spaces/file.txt"],
  });

  assert.equal(report.ok, true); // Warnings only
  assert.equal(report.issues.length, 3);
  assert.ok(report.issues.some((i) => i.kind === "shell-metacharacter-risk"));
  assert.ok(report.issues.some((i) => i.kind === "path-space-unquoted"));
});

test("auditArgumentFidelity preserves Unicode and multiline strings", () => {
  const report = auditArgumentFidelity({
    tool: "editor",
    args: ["commit -m", "feat: 🚀 support multiline\nsecond line\nthird line", "café naïve 測試"],
  });

  assert.equal(report.ok, true);
  assert.equal(report.issues.length, 0);
  assert.equal(report.fidelityScore, 1);
});

test("auditArgumentFidelity verifies JSON roundtrip for structured parameters", () => {
  const report = auditArgumentFidelity({
    tool: "rpc",
    args: {
      action: "configure",
      options: { timeoutMs: 5000, enabled: true, tags: ["prod", "web"] },
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.issues.length, 0);
});

test("verifyExecutionFidelity detects dropped or morphed arguments", () => {
  const intended = ["node", "test.js", "--filter", "test one", null];
  const executed = ["node", "test.js", "--filter", "test_one"]; // space altered to underscore and null dropped

  const report = verifyExecutionFidelity(intended, executed);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((i) => i.kind === "argument-dropped"));
  assert.ok(report.issues.some((i) => i.kind === "argument-morphed"));
});

test("createFidelityPreservingCommand normalizes arguments cleanly into argv array", () => {
  const cmd = createFidelityPreservingCommand("git", ["commit", "-m", "fix: issue #89", null, undefined]);
  assert.equal(cmd.command, "git");
  assert.deepEqual(cmd.args, ["commit", "-m", "fix: issue #89", "", ""]);
});
