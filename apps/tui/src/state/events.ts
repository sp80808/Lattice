import type { RunEvent } from "@lattice/protocol";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

/** Present only observed public summaries and metadata, never inferred progress. */
export function describeEvent(event: RunEvent): { phase: string; text?: string } {
  const payload = object(event.payload);
  const nested = object(payload.event);
  const detail = typeof nested.type === "string" ? nested : payload;
  const identity = object(detail.identity);
  const usage = object(detail.usage);
  const outcome = object(payload.outcome);
  const command = object(payload.result);
  const phase = [event.type, detail.type, payload.tool].filter(value => typeof value === "string").join(" · ");
  const text: string[] = [];
  if (typeof identity.model === "string") text.push(`Model: ${identity.model}`);
  else if (typeof identity.provider === "string") text.push(`Provider: ${identity.provider}`);
  if (typeof usage.totalTokens === "number") text.push(`Tokens: ${usage.totalTokens}`);
  if (typeof usage.costUsd === "number") text.push(`Cost: $${usage.costUsd.toFixed(4)}`);
  if (Array.isArray(detail.selected)) text.push(`Selected: ${detail.selected.filter(value => typeof value === "string").join(", ")}`);
  if (Array.isArray(detail.candidates)) text.push(`Candidates: ${detail.candidates.map(value => object(value).label).filter(value => typeof value === "string").join("; ")}`);
  if (Array.isArray(payload.evidence)) text.push(`Evidence: ${payload.evidence.length}`);
  if (typeof outcome.summary === "string") text.push(outcome.summary);
  if (typeof command.command === "string") text.push(`Check: ${command.command} · exit=${command.exitCode ?? "unknown"}${command.timedOut ? " · timed out" : ""}`);
  if (typeof payload.passed === "boolean") text.push(`Verification: ${payload.passed ? "passed" : "failed"}`);
  if (typeof detail.error === "string") text.push(detail.error);
  return { phase, text: text.join("\n") || undefined };
}
