/**
 * CPU/GPU-aware scheduling policy.
 *
 * Rules, in order:
 *   1. CPU for suitable compilers, tests, preprocessing and verification.
 *   2. Local small models for cheap decision inference.
 *   3. GPU only for workloads that benefit materially from acceleration.
 *   4. Avoid duplicate model loads and unnecessary Colab provisioning.
 *   5. Any new paid resource requires explicit approval.
 */

import {
  CLASS_COMPUTE_UNITS_PER_HOUR,
  classifyAccelerator,
  type ColabSession,
  type ColabUsage,
  type SessionAccelerator,
  type SessionClass,
} from "./client.js";

export type WorkloadKind =
  | "compile"
  | "test"
  | "preprocess"
  | "verify"
  | "decision-inference"
  | "generation"
  | "training"
  | "benchmark-heavy";

export interface Workload {
  kind: WorkloadKind;
  /** Estimated cost/benefit of acceleration, 0..1. Drives the GPU gate. */
  accelerationBenefit: number;
  /** Approximate resident memory in MB, used to avoid duplicate loads. */
  estimatedMemoryMb?: number;
  /** A decision-model inference job is cheap and local. */
  requiresNetwork?: boolean;
}

export type ScheduleBackend = "local-cpu" | "local-model" | "colab-cpu" | "colab-gpu" | "unavailable";

export interface ScheduleDecision {
  backend: ScheduleBackend;
  reason: string;
  /** Set when the decision would start or extend paid compute. */
  requiresApproval: boolean;
  estimatedComputeUnitsPerHour: number;
  /** Sessions already loaded with a compatible model, to avoid duplicates. */
  reuseSession?: string;
}

export interface SchedulerContext {
  sessions: readonly ColabSession[];
  sessionClasses?: ReadonlyMap<string, SessionClass>;
  /** Models already resident, so duplicate loads are avoided. */
  residentModels?: readonly string[];
  usage?: ColabUsage;
  /** Hard CU ceiling beyond which new paid compute is refused outright. */
  computeUnitBudget?: number;
  /** Whether the operator has approved spending on new paid resources. */
  approvedForPaidResources?: boolean;
}

/** Workloads that are always CPU-appropriate regardless of size. */
const CPU_NATIVE: ReadonlySet<WorkloadKind> = new Set<WorkloadKind>([
  "compile",
  "test",
  "preprocess",
  "verify",
]);

/** Acceleration must clear this bar before a GPU session is justified. */
export const GPU_BENEFIT_THRESHOLD = 0.5;

export function schedule(workload: Workload, context: SchedulerContext): ScheduleDecision {
  const resident = context.residentModels ?? [];

  // 1. CPU-native work never gets a GPU.
  if (CPU_NATIVE.has(workload.kind)) {
    const cpuSession = context.sessions.find((s) => s.accelerator === "cpu");
    if (cpuSession) {
      return {
        backend: "colab-cpu",
        reason: `${workload.kind} is CPU-appropriate; reuse existing CPU session ${cpuSession.name}`,
        requiresApproval: false,
        estimatedComputeUnitsPerHour: CLASS_COMPUTE_UNITS_PER_HOUR["cpu-verification"],
        reuseSession: cpuSession.name,
      };
    }
    return {
      backend: "local-cpu",
      reason: `${workload.kind} is CPU-appropriate; run locally`,
      requiresApproval: false,
      estimatedComputeUnitsPerHour: 0,
    };
  }

  // 2. Cheap decision inference stays on local small models.
  if (workload.kind === "decision-inference" || workload.accelerationBenefit < 0.2) {
    return {
      backend: "local-model",
      reason: "decision inference is cheap; use the local small model",
      requiresApproval: false,
      estimatedComputeUnitsPerHour: 0,
    };
  }

  // 3. GPU only when acceleration materially helps.
  const wantsGpu = workload.kind === "training" || workload.accelerationBenefit >= GPU_BENEFIT_THRESHOLD;
  if (wantsGpu) {
    const gpuSession = context.sessions.find((s) => s.accelerator === "gpu");
    if (gpuSession) {
      const alreadyLoaded = resident.length > 0;
      return {
        backend: "colab-gpu",
        reason: alreadyLoaded
          ? `acceleration benefit ${workload.accelerationBenefit.toFixed(2)} justifies reusing loaded GPU session ${gpuSession.name}`
          : `acceleration benefit ${workload.accelerationBenefit.toFixed(2)} justifies GPU session ${gpuSession.name}`,
        requiresApproval: false,
        estimatedComputeUnitsPerHour: CLASS_COMPUTE_UNITS_PER_HOUR["gpu-training"],
        reuseSession: gpuSession.name,
      };
    }
    // No GPU session exists: this would provision new paid compute.
    const overBudget =
      context.computeUnitBudget !== undefined &&
      context.usage !== undefined &&
      context.usage.usageRatePerHour + CLASS_COMPUTE_UNITS_PER_HOUR["gpu-training"] > context.computeUnitBudget;
    if (!context.approvedForPaidResources) {
      return {
        backend: "unavailable",
        reason:
          "no eligible GPU session exists; provisioning new paid Colab compute requires explicit approval " +
          "(Lattice never spends compute units on its own)",
        requiresApproval: true,
        estimatedComputeUnitsPerHour: CLASS_COMPUTE_UNITS_PER_HOUR["gpu-training"],
      };
    }
    if (overBudget) {
      return {
        backend: "unavailable",
        reason:
          `GPU session would raise the usage rate to ${(context.usage!.usageRatePerHour + CLASS_COMPUTE_UNITS_PER_HOUR["gpu-training"]).toFixed(2)} CU/hr, ` +
          `above the configured ${context.computeUnitBudget} CU/hr budget`,
        requiresApproval: false,
        estimatedComputeUnitsPerHour: CLASS_COMPUTE_UNITS_PER_HOUR["gpu-training"],
      };
    }
    return {
      backend: "colab-gpu",
      reason: "approved new GPU provisioning",
      requiresApproval: true,
      estimatedComputeUnitsPerHour: CLASS_COMPUTE_UNITS_PER_HOUR["gpu-training"],
    };
  }

  // 4. Generation that does not need a GPU runs on a CPU session.
  const cpuSession = context.sessions.find((s) => s.accelerator === "cpu");
  if (cpuSession) {
    return {
      backend: "colab-cpu",
      reason: `acceleration benefit ${workload.accelerationBenefit.toFixed(2)} is below the GPU bar; use CPU session ${cpuSession.name}`,
      requiresApproval: false,
      estimatedComputeUnitsPerHour: CLASS_COMPUTE_UNITS_PER_HOUR["cpu-verification"],
      reuseSession: cpuSession.name,
    };
  }
  return {
    backend: "local-cpu",
    reason: "no Colab session configured; run generation locally",
    requiresApproval: false,
    estimatedComputeUnitsPerHour: 0,
  };
}

/**
 * Detect inefficient CPU inference: a CPU session with a model loaded is
 * almost always a scheduling mistake, and compilers/tests are not.
 */
export function findInefficientCpuSessions(
  sessions: readonly ColabSession[],
  observed: ReadonlyMap<string, { modelProcessRunning?: boolean; testProcessRunning?: boolean; cpuLoad?: number }>,
): Array<{ session: string; issue: string }> {
  const problems: Array<{ session: string; issue: string }> = [];
  for (const session of sessions) {
    if (session.accelerator !== "cpu") continue;
    const obs = observed.get(session.name);
    if (obs?.modelProcessRunning) {
      problems.push({
        session: session.name,
        issue: "model inference on a CPU session is inefficient; route inference to a local small model or a GPU session",
      });
    }
    if (!obs?.modelProcessRunning && !obs?.testProcessRunning && (obs?.cpuLoad ?? 0) < 0.1) {
      problems.push({ session: session.name, issue: "CPU session is idle and burning compute units" });
    }
  }
  return problems;
}

/** Normalise the accelerator label reported by the CLI. */
export function acceleratorOf(session: ColabSession): SessionAccelerator {
  return classifyAccelerator(session.acceleratorLabel) === "unknown"
    ? session.accelerator
    : classifyAccelerator(session.acceleratorLabel);
}
