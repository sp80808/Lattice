import test from "node:test";
import assert from "node:assert/strict";
import {
  UnifiedCapabilityIndex,
  type CapabilityDescriptor,
} from "./capabilities.js";

const sampleCapabilities: CapabilityDescriptor[] = [
  {
    id: "vitest-runner",
    kind: "verifier",
    source: "local",
    description: "Executes vitest test suite for JavaScript and TypeScript projects",
    taskClasses: ["test", "bugfix", "debug"],
    stackConstraints: ["typescript", "javascript", "react"],
    requiredCapabilities: [],
    permissionScope: ["read", "exec"],
    trustLevel: "verified",
    activationCost: 1,
    latencyEstimateMs: 200,
  },
  {
    id: "cargo-test-runner",
    kind: "verifier",
    source: "local",
    description: "Executes cargo test suite for Rust repositories",
    taskClasses: ["test", "bugfix"],
    stackConstraints: ["rust"],
    requiredCapabilities: [],
    permissionScope: ["read", "exec"],
    trustLevel: "verified",
    activationCost: 2,
    latencyEstimateMs: 500,
  },
  {
    id: "react-mobile-ux",
    kind: "skill",
    source: "skills/react-mobile-ux/SKILL.md",
    description: "Guidelines and techniques for touch layouts, mobile viewports and responsive CSS",
    taskClasses: ["ui"],
    stackConstraints: ["react", "mobile", "web"],
    requiredCapabilities: [],
    permissionScope: ["read"],
    trustLevel: "verified",
    activationCost: 1,
    latencyEstimateMs: 20,
    dependencies: ["vitest-runner"],
  },
  {
    id: "legacy-mobile-ux",
    kind: "skill",
    source: "skills/legacy-mobile-ux/SKILL.md",
    description: "Alternative legacy mobile layout rules",
    taskClasses: ["ui"],
    stackConstraints: ["react", "mobile"],
    requiredCapabilities: [],
    permissionScope: ["read"],
    trustLevel: "local",
    activationCost: 3,
    conflictsWith: ["react-mobile-ux"],
  },
];

test("UnifiedCapabilityIndex filters eligible capabilities by stack constraints", () => {
  const index = new UnifiedCapabilityIndex(sampleCapabilities);

  const rustEligible = index.filterEligible({ stacks: ["rust"] });
  assert.equal(rustEligible.length, 1);
  assert.equal(rustEligible[0].id, "cargo-test-runner");

  const reactEligible = index.filterEligible({ stacks: ["react"] });
  assert.ok(reactEligible.some((c) => c.id === "vitest-runner"));
  assert.ok(reactEligible.some((c) => c.id === "react-mobile-ux"));
  assert.ok(!reactEligible.some((c) => c.id === "cargo-test-runner"));
});

test("selectOptimalBundle returns empty bundle when no skills match or are relevant", async () => {
  const index = new UnifiedCapabilityIndex(sampleCapabilities);
  const bundle = await index.selectOptimalBundle("unrelated quantum computing task", {
    stacks: ["python"],
    taskClasses: ["research"],
  });

  assert.equal(bundle.source, "empty");
  assert.equal(bundle.selected.length, 0);
});

test("selectOptimalBundle auto-resolves dependencies and respects conflicts (SkillMOO)", async () => {
  const index = new UnifiedCapabilityIndex(sampleCapabilities);
  const bundle = await index.selectOptimalBundle("fix mobile touch layout in react", {
    stacks: ["react", "mobile"],
    taskClasses: ["ui"],
  });

  assert.equal(bundle.source, "deterministic");
  assert.ok(bundle.selected.some((c) => c.id === "react-mobile-ux"));
  // Auto-included dependency
  assert.ok(bundle.selected.some((c) => c.id === "vitest-runner"));
  // Conflicting skill must be rejected
  assert.ok(!bundle.selected.some((c) => c.id === "legacy-mobile-ux"));
  assert.ok(bundle.rejected.some((r) => r.id === "legacy-mobile-ux" && r.reason.includes("Conflicts")));
});
