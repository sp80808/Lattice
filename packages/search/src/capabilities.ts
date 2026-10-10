import { Bm25SkillRetriever, type SkillDefinition } from "./retrieval.js";
import type { DecisionChoice, DecisionProvider, DecisionResult } from "@lattice/protocol";

export type CapabilityKind = "skill" | "mcp" | "connector" | "docs" | "verifier";
export type TrustLevel = "verified" | "local" | "third_party" | "untrusted";

export interface CapabilityDescriptor {
  id: string;
  kind: CapabilityKind;
  source: string;
  version?: string;
  contentHash?: string;
  description: string;
  taskClasses: string[];
  stackConstraints: string[];
  requiredCapabilities: string[];
  permissionScope: string[];
  trustLevel: TrustLevel;
  activationCost?: number;
  latencyEstimateMs?: number;
  verifiedSuccessEvidence?: string[];
  conflictsWith?: string[];
  dependencies?: string[];
  parameters?: Record<string, unknown>;
}

export interface CapabilityFilterContext {
  taskClasses?: string[];
  stacks?: string[];
  platforms?: string[];
  maxTrustLevel?: TrustLevel;
}

export interface BundleOptimizationCriteria {
  /** Maximum capabilities in bundle (default 5). */
  maxBundleSize?: number;
  /** Favor minimal bundles by penalizing cumulative activation cost. */
  pruneRedundant?: boolean;
  /** Allow 0 capabilities if relevance does not clear threshold (default true). */
  allowEmpty?: boolean;
  /** Minimum score threshold for inclusion (default 0.8). */
  minRelevanceScore?: number;
}

export interface SelectedCapabilityBundle {
  selected: CapabilityDescriptor[];
  rejected: Array<{ id: string; reason: string }>;
  totalActivationCost: number;
  estimatedLatencyMs: number;
  source: "deterministic" | "model-escalated" | "empty";
  decisionTrace?: DecisionResult;
}

/**
 * Unified Capability Index (Section 4).
 * Indexes skills, MCP servers, verifiers, connectors and docs without loading bulky instructions.
 */
export class UnifiedCapabilityIndex {
  private readonly capabilities: Map<string, CapabilityDescriptor> = new Map();
  private retriever: Bm25SkillRetriever = new Bm25SkillRetriever();

  constructor(initial: CapabilityDescriptor[] = []) {
    for (const cap of initial) {
      this.register(cap);
    }
  }

  public register(cap: CapabilityDescriptor): void {
    this.capabilities.set(cap.id, cap);
    const asSkill: SkillDefinition = {
      id: cap.id,
      name: cap.id,
      description: cap.description,
      keywords: [...cap.taskClasses, ...cap.stackConstraints, ...cap.permissionScope],
      riskLevel: cap.trustLevel === "untrusted" || cap.permissionScope.some((p) => /write|delete|admin/i.test(p)) ? "high" : "low",
    };
    this.retriever.addSkill(asSkill);
  }

  public get(id: string): CapabilityDescriptor | undefined {
    return this.capabilities.get(id);
  }

  public list(): CapabilityDescriptor[] {
    return Array.from(this.capabilities.values());
  }

  /**
   * Filters eligible capabilities based on repository stack and task classification.
   */
  public filterEligible(context: CapabilityFilterContext): CapabilityDescriptor[] {
    return Array.from(this.capabilities.values()).filter((cap) => {
      // 1. Stack constraints: if capability declares stack constraints, at least one must match context stacks
      if (cap.stackConstraints.length > 0 && context.stacks && context.stacks.length > 0) {
        const matchesStack = cap.stackConstraints.some((constraint) =>
          context.stacks!.some((s) => s.toLowerCase() === constraint.toLowerCase()),
        );
        if (!matchesStack) return false;
      }

      // 2. Task class constraints: if capability declares task classes, at least one must match
      if (cap.taskClasses.length > 0 && context.taskClasses && context.taskClasses.length > 0) {
        const matchesClass = cap.taskClasses.some((tc) =>
          context.taskClasses!.some((c) => c.toLowerCase() === tc.toLowerCase()),
        );
        if (!matchesClass) return false;
      }

      return true;
    });
  }

  /**
   * Multi-objective capability bundle optimization (SkillMOO pattern).
   *
   * Solves Pareto selection: maximizes task relevance while pruning redundant,
   * conflicting, or excessive capabilities.
   */
  public async selectOptimalBundle(
    query: string,
    context: CapabilityFilterContext,
    criteria: BundleOptimizationCriteria = {},
    decisionProvider?: DecisionProvider,
  ): Promise<SelectedCapabilityBundle> {
    const minRelevance = criteria.minRelevanceScore ?? 0.8;
    const maxBundleSize = criteria.maxBundleSize ?? 5;
    const allowEmpty = criteria.allowEmpty ?? true;

    // Phase 1: Eligibility filter
    const eligible = this.filterEligible(context);
    const eligibleIds = new Set(eligible.map((c) => c.id));

    if (eligible.length === 0 && allowEmpty) {
      return {
        selected: [],
        rejected: [],
        totalActivationCost: 0,
        estimatedLatencyMs: 0,
        source: "empty",
      };
    }

    // Phase 2: BM25 Lexical / Intent Retrieval
    const rankedMatches = this.retriever.retrieve(query, { topK: 10 });
    const relevant = rankedMatches
      .filter((m) => eligibleIds.has(m.skill.id) && m.score >= minRelevance)
      .map((m) => {
        const cap = this.capabilities.get(m.skill.id)!;
        const trustMultiplier =
          cap.trustLevel === "verified" ? 1.2 : cap.trustLevel === "local" ? 1.0 : cap.trustLevel === "third_party" ? 0.8 : 0.5;
        const costPenalty = Math.sqrt(Math.max(1, cap.activationCost ?? 1));
        const mooScore = (m.score * trustMultiplier) / costPenalty;
        return { match: m, cap, mooScore };
      });

    // SkillMOO: Sort by multi-objective score (relevance, trust, cost efficiency)
    relevant.sort((a, b) => b.mooScore - a.mooScore);

    if (relevant.length === 0 && allowEmpty) {
      return {
        selected: [],
        rejected: rankedMatches.map((m) => ({ id: m.skill.id, reason: `Relevance score ${m.score.toFixed(2)} below threshold ${minRelevance}` })),
        totalActivationCost: 0,
        estimatedLatencyMs: 0,
        source: "empty",
      };
    }

    // Phase 3: Pareto Pruning & Conflict Resolution (SkillMOO)
    const selected: CapabilityDescriptor[] = [];
    const rejected: Array<{ id: string; reason: string }> = [];
    const selectedIds = new Set<string>();

    for (const item of relevant) {
      const cap = item.cap;

      // Check bundle capacity
      if (selected.length >= maxBundleSize) {
        rejected.push({ id: cap.id, reason: `Max bundle size of ${maxBundleSize} reached` });
        continue;
      }

      // Check conflicts bi-directionally
      const isConflicted =
        (cap.conflictsWith && cap.conflictsWith.some((confId) => selectedIds.has(confId))) ||
        selected.some((sel) => sel.conflictsWith && sel.conflictsWith.includes(cap.id));
      if (isConflicted) {
        rejected.push({ id: cap.id, reason: `Conflicts with already selected capability in bundle` });
        continue;
      }

      // Redundancy check: if a skill of the exact same kind and task class already exists with higher score
      if (criteria.pruneRedundant !== false) {
        const redundant = selected.some(
          (sel) => sel.kind === cap.kind && sel.taskClasses.some((tc) => cap.taskClasses.includes(tc)),
        );
        if (redundant && selected.length >= 2) {
          rejected.push({ id: cap.id, reason: "Pruned as redundant overlapping capability (SkillMOO Pareto prune)" });
          continue;
        }
      }

      // Satisfy dependencies
      if (cap.dependencies) {
        for (const depId of cap.dependencies) {
          if (!selectedIds.has(depId)) {
            const depCap = this.capabilities.get(depId);
            if (depCap) {
              selected.push(depCap);
              selectedIds.add(depId);
            }
          }
        }
      }

      selected.push(cap);
      selectedIds.add(cap.id);
    }

    // Phase 4: Escalation check if there is ambiguity or conflicting choices
    let decisionTrace: DecisionResult | undefined;
    let source: "deterministic" | "model-escalated" | "empty" = "deterministic";

    if (selected.length > 1 && decisionProvider) {
      const top1 = relevant[0];
      const top2 = relevant[1];
      const margin = top1 && top2 ? top1.match.score - top2.match.score : 1.0;

      // If top choices are in a near tie (tight margin < 0.2), ask decision model to refine priority
      if (margin < 0.2) {
        const choices: DecisionChoice[] = selected.map((c) => ({
          id: c.id,
          label: c.id,
          detail: `${c.description} [cost: ${c.activationCost ?? 1}, latency: ${c.latencyEstimateMs ?? 50}ms]`,
        }));

        try {
          decisionTrace = await decisionProvider.decide({
            question: `Select highest priority capability for request: "${query}"`,
            choices,
            allowUnknown: true,
          });
          source = "model-escalated";
        } catch {
          // Fall back gracefully to deterministic selection
        }
      }
    }

    const totalActivationCost = selected.reduce((sum, c) => sum + (c.activationCost ?? 1), 0);
    const estimatedLatencyMs = Math.max(0, ...selected.map((c) => c.latencyEstimateMs ?? 50));

    return {
      selected,
      rejected,
      totalActivationCost,
      estimatedLatencyMs,
      source,
      decisionTrace,
    };
  }
}
