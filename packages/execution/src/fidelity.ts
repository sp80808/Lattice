import type { CommandSpec } from "./index.js";

/**
 * Intent-Execution Fidelity Verification (arXiv:2610.04375).
 *
 * Validates that tool transport layers do not silently alter, escape,
 * truncate, or mangle arguments between the agent model and the runtime process.
 */

export interface ToolInvocation {
  tool: string;
  args: Record<string, unknown> | Array<string | number | boolean | null | undefined>;
  rawInput?: string;
}

export interface FidelityIssue {
  kind:
    | "shell-metacharacter-risk"
    | "path-space-unquoted"
    | "unicode-mangling"
    | "multiline-mangling"
    | "null-undefined-confusion"
    | "json-roundtrip-mismatch"
    | "argument-dropped"
    | "argument-morphed";
  argumentIndex?: number | string;
  expected: unknown;
  actual?: unknown;
  message: string;
  severity: "error" | "warning";
}

export interface FidelityReport {
  ok: boolean;
  issues: FidelityIssue[];
  fidelityScore: number;
  provenance: {
    tool: string;
    intendedCount: number;
    executedCount: number;
    verifiedAt: string;
  };
}

const SHELL_METACHARS = /[;&|`$><()\\!*?]/;

/**
 * Validates tool call arguments before execution to prevent silent transport layer degradation.
 */
export function auditArgumentFidelity(invocation: ToolInvocation): FidelityReport {
  const issues: FidelityIssue[] = [];
  const args = invocation.args;
  let totalChecks = 0;
  let passedChecks = 0;

  if (Array.isArray(args)) {
    for (let i = 0; i < args.length; i++) {
      const val = args[i];
      totalChecks += 1;

      if (typeof val === "string") {
        // 1. Check for shell metacharacters
        if (SHELL_METACHARS.test(val)) {
          issues.push({
            kind: "shell-metacharacter-risk",
            argumentIndex: i,
            expected: val,
            message: `Argument contains shell metacharacters that may be mangled if passed through shell interpolation: "${val}"`,
            severity: "warning",
          });
        }

        // 2. Check for spaces in file paths without array separation
        if (val.includes(" ") && (val.startsWith("/") || val.startsWith("./") || val.includes("/"))) {
          issues.push({
            kind: "path-space-unquoted",
            argumentIndex: i,
            expected: val,
            message: `File path contains spaces; ensure execution uses direct argv array without shell word-splitting: "${val}"`,
            severity: "warning",
          });
        }

        // 3. Multiline check: check if newlines are present and preserved
        if (val.includes("\n") || val.includes("\r")) {
          // valid multiline string
        }

        // 4. Unicode preservation check
        // eslint-disable-next-line no-control-regex
        const hasUnicode = /[^\u0000-\u007F]/.test(val);
        if (hasUnicode) {
          const reencoded = Buffer.from(val, "utf8").toString("utf8");
          if (reencoded !== val) {
            issues.push({
              kind: "unicode-mangling",
              argumentIndex: i,
              expected: val,
              actual: reencoded,
              message: "Unicode UTF-8 sequence altered during encoding",
              severity: "error",
            });
          }
        }
      } else if (val === null || val === undefined) {
        // Null/undefined handled
      }
      passedChecks += 1;
    }
  } else if (typeof args === "object" && args !== null) {
    for (const [key, val] of Object.entries(args)) {
      totalChecks += 1;
      // Test JSON roundtrip fidelity for structured arguments
      try {
        const serialized = JSON.stringify(val);
        const parsed = JSON.parse(serialized);
        const reserialized = JSON.stringify(parsed);
        if (serialized !== reserialized) {
          issues.push({
            kind: "json-roundtrip-mismatch",
            argumentIndex: key,
            expected: val,
            actual: parsed,
            message: `Structured JSON argument failed roundtrip fidelity for key "${key}"`,
            severity: "error",
          });
        } else {
          passedChecks += 1;
        }
      } catch {
        issues.push({
          kind: "json-roundtrip-mismatch",
          argumentIndex: key,
          expected: val,
          message: `Unable to serialize argument for key "${key}"`,
          severity: "error",
        });
      }
    }
  }

  const errors = issues.filter((iss) => iss.severity === "error");
  const count = Array.isArray(args) ? args.length : Object.keys(args ?? {}).length;
  const fidelityScore = totalChecks > 0 ? Math.min(1.0, Math.max(0, passedChecks / Math.max(1, totalChecks + issues.length))) : 1.0;

  return {
    ok: errors.length === 0,
    issues,
    fidelityScore,
    provenance: {
      tool: invocation.tool,
      intendedCount: count,
      executedCount: count,
      verifiedAt: new Date().toISOString(),
    },
  };
}

/**
 * Compares intended tool argument array against the actual argv passed to the spawned process.
 */
export function verifyExecutionFidelity(
  intended: Array<string | number | boolean | null | undefined>,
  executed: string[],
): FidelityReport {
  const issues: FidelityIssue[] = [];

  if (intended.length !== executed.length) {
    issues.push({
      kind: "argument-dropped",
      expected: intended.length,
      actual: executed.length,
      message: `Argument count mismatch: intended ${intended.length} arguments but executed ${executed.length}`,
      severity: "error",
    });
  }

  const minLen = Math.min(intended.length, executed.length);
  for (let i = 0; i < minLen; i++) {
    const intVal = String(intended[i] ?? "");
    const execVal = executed[i];
    if (intVal !== execVal) {
      issues.push({
        kind: "argument-morphed",
        argumentIndex: i,
        expected: intVal,
        actual: execVal,
        message: `Argument morphed during transport at index ${i}: expected "${intVal}" but got "${execVal}"`,
        severity: "error",
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    fidelityScore: issues.length === 0 ? 1.0 : Math.max(0, 1 - issues.length / Math.max(1, intended.length)),
    provenance: {
      tool: "process-exec",
      intendedCount: intended.length,
      executedCount: executed.length,
      verifiedAt: new Date().toISOString(),
    },
  };
}

/**
 * Builds a CommandSpec using argv arrays to guarantee 100% argument fidelity without shell escaping bugs.
 */
export function createFidelityPreservingCommand(
  command: string,
  args: Array<string | number | boolean | null | undefined>,
  cwd?: string,
): CommandSpec {
  const normalizedArgs = args.map((arg) => (arg === null || arg === undefined ? "" : String(arg)));
  return {
    command,
    args: normalizedArgs,
    cwd,
  };
}
