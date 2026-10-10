import {
  fingerprintProject,
  classifyTask,
  auditArgumentFidelity,
  createFidelityPreservingCommand,
  runCommand,
  type ProjectFingerprint,
  type TaskClass,
  type FidelityReport,
} from "@lattice/execution";
import {
  UnifiedCapabilityIndex,
  type CapabilityDescriptor,
  type SelectedCapabilityBundle,
} from "@lattice/search";
import type { TapPacket, EvidenceRef } from "@lattice/protocol";

export type AutonomyLevel = "observe" | "plan" | "supervised" | "auto";

export interface AdaptiveTaskOptions {
  task: string;
  cwd: string;
  autonomy?: AutonomyLevel;
  capabilityIndex?: UnifiedCapabilityIndex;
  maxRounds?: number;
  timeoutMs?: number;
}

export interface VerificationContract {
  id: string;
  commands: string[];
  expectedOutcomes: string[];
  preconditionsVerified: boolean;
  oracleKind: "repo-test" | "compiler" | "build" | "custom";
}

export interface AdaptiveTaskResult {
  status: "completed" | "needs_clarification" | "failed";
  fingerprint: ProjectFingerprint;
  taskClassification: { class: TaskClass; confidence: number; matched: string[] };
  capabilities: SelectedCapabilityBundle;
  contract: VerificationContract;
  evidence: EvidenceRef[];
  fidelityReport: FidelityReport;
  summary: string;
  clarificationPrompt?: string;
}

/**
 * Standard dynamic skill recipes (Section 6).
 */
export const SYSTEMATIC_DEBUGGING_RECIPE: CapabilityDescriptor = {
  id: "recipe-systematic-debugging",
  kind: "skill",
  source: "recipes/systematic-debugging.md",
  description: "Reproduce symptom -> locate symbols -> construct failing test -> isolate cause -> minimal fix -> independent verify",
  taskClasses: ["bugfix", "debug"],
  stackConstraints: [],
  requiredCapabilities: [],
  permissionScope: ["read", "exec"],
  trustLevel: "verified",
  activationCost: 1,
  latencyEstimateMs: 100,
};

export const SPEC_AND_IMPLEMENTATION_RECIPE: CapabilityDescriptor = {
  id: "recipe-spec-implementation",
  kind: "skill",
  source: "recipes/spec-implementation.md",
  description: "Convert requirements into acceptance contract, research exact API versions, isolate worktree changes",
  taskClasses: ["feature", "refactor"],
  stackConstraints: [],
  requiredCapabilities: [],
  permissionScope: ["read", "write"],
  trustLevel: "verified",
  activationCost: 2,
  latencyEstimateMs: 150,
};

export const VERIFICATION_BEFORE_COMPLETION_RECIPE: CapabilityDescriptor = {
  id: "recipe-verification-before-completion",
  kind: "skill",
  source: "recipes/verification.md",
  description: "Run deterministic checks, independent behaviour review, regression tests before claiming completion",
  taskClasses: ["test", "bugfix", "feature"],
  stackConstraints: [],
  requiredCapabilities: [],
  permissionScope: ["read", "exec"],
  trustLevel: "verified",
  activationCost: 1,
  latencyEstimateMs: 200,
};

export const WEB_PWA_UX_RECIPE: CapabilityDescriptor = {
  id: "recipe-web-ux-verification",
  kind: "skill",
  source: "recipes/web-ux.md",
  description: "Test responsive viewports, touch safe areas, overlap collision, overflow and accessibility",
  taskClasses: ["ui"],
  stackConstraints: ["react", "web", "mobile", "next", "vite"],
  requiredCapabilities: [],
  permissionScope: ["read", "browser"],
  trustLevel: "verified",
  activationCost: 2,
  latencyEstimateMs: 300,
};

export const TESSERA_COMPILER_RECIPE: CapabilityDescriptor = {
  id: "recipe-tessera-compiler",
  kind: "skill",
  source: "recipes/tessera.md",
  description: "Tessera tsr compiler witness validation, byte alignment, and language-specific tests",
  taskClasses: ["bugfix", "feature", "performance"],
  stackConstraints: ["compiler", "tessera", "rust"],
  requiredCapabilities: [],
  permissionScope: ["read", "exec"],
  trustLevel: "verified",
  activationCost: 2,
  latencyEstimateMs: 250,
};

export const BUNDLED_RECIPES: CapabilityDescriptor[] = [
  SYSTEMATIC_DEBUGGING_RECIPE,
  SPEC_AND_IMPLEMENTATION_RECIPE,
  VERIFICATION_BEFORE_COMPLETION_RECIPE,
  WEB_PWA_UX_RECIPE,
  TESSERA_COMPILER_RECIPE,
];

/**
 * Executes the Adaptive One-Shot Coding Workflow (Section 7).
 *
 * UNDERSTAND -> CLASSIFY -> INSPECT -> SELECT CAPABILITIES -> FREEZE ACCEPTANCE CONTRACT -> INDEPENDENT VERIFY
 */
export async function runAdaptiveWorkflow(
  options: AdaptiveTaskOptions,
): Promise<AdaptiveTaskResult> {
  const { task, cwd } = options;
  const autonomy = options.autonomy ?? "supervised";

  // 1. INSPECT: Deterministic project fingerprint
  const fingerprint = await fingerprintProject(cwd);

  // 2. CLASSIFY: Deterministic lexical task classification
  const classification = classifyTask(task);

  // 3. CAPABILITY SELECTION: Multistage planner with SkillMOO bundle optimization
  const index = options.capabilityIndex ?? new UnifiedCapabilityIndex(BUNDLED_RECIPES);
  const bundle = await index.selectOptimalBundle(task, {
    stacks: fingerprint.stacks,
    taskClasses: [classification.class, ...classification.matched],
    platforms: fingerprint.platforms,
  });

  // 4. FREEZE ACCEPTANCE CONTRACT: Independent verification oracles
  const verifyCommands: string[] = [];
  if (fingerprint.testCommands.length > 0) {
    verifyCommands.push(...fingerprint.testCommands);
  } else if (fingerprint.buildCommands.length > 0) {
    verifyCommands.push(...fingerprint.buildCommands);
  }

  const contract: VerificationContract = {
    id: `contract-${Date.now()}`,
    commands: verifyCommands,
    expectedOutcomes: ["exit-code-0"],
    preconditionsVerified: verifyCommands.length > 0,
    oracleKind: fingerprint.testCommands.length > 0 ? "repo-test" : "build",
  };

  // 5. INTENT-EXECUTION FIDELITY: Audit verification commands
  const fidelityReport = auditArgumentFidelity({
    tool: "verifier",
    args: verifyCommands,
  });

  // 6. INTELLIGENT USER CLARIFICATION: Check if consequential ambiguity requires user interaction
  const isDestructive = /\b(delete|drop|purge|rm\s+-rf|destroy)\b/i.test(task);
  if (isDestructive && autonomy !== "auto") {
    return {
      status: "needs_clarification",
      fingerprint,
      taskClassification: classification,
      capabilities: bundle,
      contract,
      evidence: [],
      fidelityReport,
      summary: "Task involves potentially destructive action; requires explicit user approval",
      clarificationPrompt: `The request "${task}" implies potentially destructive file modifications. Do you authorize this action?`,
    };
  }

  // 7. EXECUTE INDEPENDENT VERIFICATION
  const evidence: EvidenceRef[] = [];
  let verificationPassed = true;

  for (const cmdStr of contract.commands) {
    // Intent-execution correspondence: Decompose compound commands connected by &&
    // into discrete, atomic process invocations to prevent argument mangling
    const subcommands = cmdStr.split(/\s*&&\s*/).filter(Boolean);

    for (const sub of subcommands) {
      const parts = sub.trim().split(/\s+/);
      const bin = parts[0]!;
      const args = parts.slice(1);
      const spec = createFidelityPreservingCommand(bin, args, cwd, options.timeoutMs ?? 180_000);

      try {
        const res = await runCommand(spec);
        evidence.push({
          id: `ev-verify-${Date.now()}-${bin}`,
          kind: "command",
          verified: res.exitCode === 0,
          source: sub,
          summary: `Verification command "${sub}" exited with ${res.exitCode} in ${res.durationMs}ms`,
          createdAt: new Date().toISOString(),
        });
        if (res.exitCode !== 0) {
          verificationPassed = false;
        }
      } catch (err) {
        verificationPassed = false;
        evidence.push({
          id: `ev-verify-err-${Date.now()}`,
          kind: "command",
          verified: false,
          source: sub,
          summary: `Failed to execute verifier: ${err instanceof Error ? err.message : String(err)}`,
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  const summary = [
    `Adaptive task classified as: ${classification.class} (${(classification.confidence * 100).toFixed(0)}% confidence).`,
    `Project stack: ${fingerprint.stacks.join(", ") || "none detected"} (${fingerprint.appType}).`,
    `Capabilities selected (${bundle.source}): [${bundle.selected.map((c) => c.id).join(", ") || "none"}].`,
    `Verification: ${contract.commands.length} command(s) evaluated; status=${verificationPassed ? "VERIFIED" : "UNVERIFIED"}.`,
  ].join(" ");

  return {
    status: verificationPassed ? "completed" : "failed",
    fingerprint,
    taskClassification: classification,
    capabilities: bundle,
    contract,
    evidence,
    fidelityReport,
    summary,
  };
}
