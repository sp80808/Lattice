import type { DecisionChoice, DecisionProvider, DecisionResult } from "@lattice/protocol";
import type { DecisionFrame } from "./index.js";

export type SkillRiskLevel = "low" | "medium" | "high";

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  keywords?: string[];
  tags?: string[];
  riskLevel?: SkillRiskLevel;
  parameters?: Record<string, unknown>;
}

export interface SkillMatch {
  skill: SkillDefinition;
  score: number;
}

export interface SkillRoutingOptions {
  /** Minimum BM25 score required for deterministic selection without model escalation (default 1.0). */
  minConfidence?: number;
  /** Minimum score delta between top-1 and top-2 required to avoid escalation (default 0.3). */
  minMargin?: number;
  /** Whether high-risk skills must always escalate to the decision model (default true). */
  forceModelIfRiskHigh?: boolean;
  /** Optional decision provider for model-assisted escalation. */
  decisionProvider?: DecisionProvider;
  /** Maximum candidate count to consider/shortlist (default 5). */
  topK?: number;
}

export interface SkillRoutingResult {
  selected: SkillDefinition | undefined;
  source: "deterministic" | "model-escalated" | "fallback";
  score: number;
  margin: number;
  candidates: SkillMatch[];
  modelDecision?: DecisionResult;
  reason?: string;
}

/** Standard tokenization: lowercases, strips punctuation, splits on word breaks. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/[\s_-]+/)
    .filter((token) => token.length > 1);
}

/**
 * Deterministic BM25 index over agent skills and capabilities (SkillSeek pattern).
 *
 * Provides sub-millisecond, zero-cost keyword and semantic-token retrieval.
 */
export class Bm25SkillRetriever {
  private readonly skills: Map<string, SkillDefinition> = new Map();
  private readonly docTokens: Map<string, string[]> = new Map();
  private readonly docLengths: Map<string, number> = new Map();
  private readonly termDocFreq: Map<string, number> = new Map();
  private avgDocLength = 0;

  private readonly k1: number;
  private readonly b: number;

  constructor(skills: SkillDefinition[] = [], options?: { k1?: number; b?: number }) {
    this.k1 = options?.k1 ?? 1.2;
    this.b = options?.b ?? 0.75;
    for (const skill of skills) {
      this.addSkill(skill);
    }
  }

  public addSkill(skill: SkillDefinition): void {
    this.skills.set(skill.id, skill);
    // Combine name, description, tags and keywords (with keyword boosting)
    const tokens: string[] = [
      ...tokenize(skill.id),
      ...tokenize(skill.name),
      ...tokenize(skill.description),
      ...(skill.keywords ?? []).flatMap((kw) => [...tokenize(kw), ...tokenize(kw)]), // 2x boost
      ...(skill.tags ?? []).flatMap((t) => tokenize(t)),
    ];
    this.docTokens.set(skill.id, tokens);
    this.docLengths.set(skill.id, tokens.length);
    this.rebuildIndex();
  }

  private rebuildIndex(): void {
    this.termDocFreq.clear();
    let totalLength = 0;
    const numDocs = this.docTokens.size;

    for (const tokens of this.docTokens.values()) {
      totalLength += tokens.length;
      const uniqueTerms = new Set(tokens);
      for (const term of uniqueTerms) {
        this.termDocFreq.set(term, (this.termDocFreq.get(term) ?? 0) + 1);
      }
    }
    this.avgDocLength = numDocs > 0 ? totalLength / numDocs : 0;
  }

  public retrieve(query: string, options?: { topK?: number }): SkillMatch[] {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0 || this.skills.size === 0) {
      return [];
    }

    const numDocs = this.skills.size;
    const scores: Array<{ skill: SkillDefinition; score: number }> = [];

    for (const [id, skill] of this.skills.entries()) {
      const docTokens = this.docTokens.get(id) ?? [];
      const docLength = this.docLengths.get(id) ?? 0;
      let score = 0;

      // Count term frequencies in this doc
      const tfMap = new Map<string, number>();
      for (const token of docTokens) {
        tfMap.set(token, (tfMap.get(token) ?? 0) + 1);
      }

      for (const qToken of queryTokens) {
        const tf = tfMap.get(qToken) ?? 0;
        if (tf === 0) continue;

        const df = this.termDocFreq.get(qToken) ?? 0;
        // Robertson-Spärck Jones IDF with smoothing
        const idf = Math.log(1 + (numDocs - df + 0.5) / (df + 0.5));
        const num = tf * (this.k1 + 1);
        const denom = tf + this.k1 * (1 - this.b + this.b * (docLength / (this.avgDocLength || 1)));
        score += idf * (num / denom);
      }

      if (score > 0) {
        scores.push({ skill, score });
      }
    }

    scores.sort((a, b) => b.score - a.score);
    const limit = options?.topK ?? scores.length;
    return scores.slice(0, limit);
  }
}

/**
 * SkillRetrievalEngine implements deterministic-first routing with model escalation.
 */
export class SkillRetrievalEngine {
  private readonly retriever: Bm25SkillRetriever;

  constructor(skills: SkillDefinition[] = [], options?: { k1?: number; b?: number }) {
    this.retriever = new Bm25SkillRetriever(skills, options);
  }

  public addSkill(skill: SkillDefinition): void {
    this.retriever.addSkill(skill);
  }

  public async route(
    query: string,
    options: SkillRoutingOptions = {},
  ): Promise<SkillRoutingResult> {
    const minConfidence = options.minConfidence ?? 1.0;
    const minMargin = options.minMargin ?? 0.3;
    const forceModelIfRiskHigh = options.forceModelIfRiskHigh ?? true;
    const topK = options.topK ?? 5;

    const matches = this.retriever.retrieve(query, { topK });

    if (matches.length === 0) {
      return {
        selected: undefined,
        source: "fallback",
        score: 0,
        margin: 0,
        candidates: [],
        reason: "No matching skills found in index",
      };
    }

    const top1 = matches[0];
    const top2 = matches.length > 1 ? matches[1] : undefined;
    const margin = top2 ? top1.score - top2.score : top1.score;
    const isHighRisk = top1.skill.riskLevel === "high";

    const confident = top1.score >= minConfidence && margin >= minMargin;
    const safe = !isHighRisk || !forceModelIfRiskHigh;

    // Fast path: Deterministic match meets confidence, margin, and safety gates
    if (confident && safe) {
      return {
        selected: top1.skill,
        source: "deterministic",
        score: top1.score,
        margin,
        candidates: matches,
        reason: `Deterministic match (score=${top1.score.toFixed(2)}, margin=${margin.toFixed(2)})`,
      };
    }

    // Escalation path: Ambiguity, low score, or high risk requires decision provider
    if (options.decisionProvider) {
      const choices: DecisionChoice[] = matches.map((m) => ({
        id: m.skill.id,
        label: m.skill.name,
        detail: `${m.skill.description} [risk: ${m.skill.riskLevel ?? "low"}, BM25 score: ${m.score.toFixed(2)}]`,
      }));

      const escalationReasons: string[] = [];
      if (top1.score < minConfidence) escalationReasons.push(`low score (${top1.score.toFixed(2)} < ${minConfidence})`);
      if (margin < minMargin) escalationReasons.push(`tight margin (${margin.toFixed(2)} < ${minMargin})`);
      if (isHighRisk && forceModelIfRiskHigh) escalationReasons.push("high-risk action");

      const frame: DecisionFrame = {
        id: `skill-esc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        class: "routing",
        objective: "Select most appropriate skill for task intent",
        question: `Which skill should be executed for: "${query}"?`,
        criteria: [
          "Match task intent accurately",
          "Ensure compatibility and verify required parameters",
          "Safeguard against unnecessary high-risk modifications",
        ],
        state: `Intent: "${query}"\nTop BM25 Candidate: ${top1.skill.name} (${top1.skill.id})\nEscalation trigger: ${escalationReasons.join(", ")}`,
        evidenceIds: [],
        choices,
        allowUnknown: true,
        audit: [],
      };

      const decision = await options.decisionProvider.decide({
        state: frame.state,
        question: frame.question,
        choices: frame.choices,
        allowUnknown: frame.allowUnknown,
      });

      const selectedId = decision.selected[0];
      const selectedSkill = matches.find((m) => m.skill.id === selectedId)?.skill;

      return {
        selected: selectedSkill,
        source: "model-escalated",
        score: top1.score,
        margin,
        candidates: matches,
        modelDecision: decision,
        reason: `Escalated to decision model (${escalationReasons.join(", ")})`,
      };
    }

    // Fallback if no decision provider is supplied but conditions not met
    return {
      selected: top1.skill,
      source: "fallback",
      score: top1.score,
      margin,
      candidates: matches,
      reason: `Uncertain match without decision provider fallback (score=${top1.score.toFixed(2)}, margin=${margin.toFixed(2)})`,
    };
  }
}
