import { createHash } from "node:crypto";
import type {
  DecisionChoice,
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
} from "@lattice/protocol";

export interface DecisionCacheEntry {
  key: string;
  frameId: string;
  repoRevision?: string;
  result: DecisionResult;
  createdAt: number;
  expiresAt: number;
  hits: number;
  lastAccessedAt: number;
}

export interface DecisionCacheOptions {
  /** Time-to-live in milliseconds. Default: 24 hours. */
  ttlMs?: number;
  /** Maximum number of entries before LRU eviction. Default: 2048. */
  maxEntries?: number;
  /** Resolves the current git repository revision or tree SHA. */
  getRepoRevision?: () => string | undefined;
  /** Flag to bypass cache lookup and writes. Default: true. */
  enabled?: boolean;
}

export interface DecisionCacheStats {
  entries: number;
  hits: number;
  misses: number;
  hitRate: number;
  evictions: number;
}

/**
 * Computes canonical frameId from a DecisionRequest.
 * Stable across whitespace, choice order, and property permutations.
 */
export function computeDecisionFrameId(request: DecisionRequest): string {
  const choices = (request.choices ?? [])
    .map((c: DecisionChoice) => ({
      id: c.id,
      label: c.label ?? "",
      detail: c.detail ?? "",
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const stateStr =
    typeof request.state === "string"
      ? request.state
      : request.state !== undefined
        ? JSON.stringify(request.state)
        : "";

  const canonical = JSON.stringify({
    question: (request.question ?? "").trim(),
    state: stateStr.trim(),
    allowUnknown: Boolean(request.allowUnknown),
    choices,
  });

  return createHash("sha256").update(canonical).digest("hex").slice(0, 20);
}

/**
 * Memoizes DecisionProvider results per (frameId, repo revision) with TTL,
 * LRU eviction, and hit accounting. Reduces redundant model calls across
 * consecutive search rounds and unmutated worktree checks.
 */
export class MemoizedDecisionProvider implements DecisionProvider {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly getRepoRevision?: () => string | undefined;
  private enabled: boolean;
  private readonly cache = new Map<string, DecisionCacheEntry>();
  private hitsCount = 0;
  private missesCount = 0;
  private evictionsCount = 0;

  constructor(
    private readonly inner: DecisionProvider,
    options: DecisionCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000; // 24 hours
    this.maxEntries = options.maxEntries ?? 2048;
    this.getRepoRevision = options.getRepoRevision;
    this.enabled = options.enabled ?? true;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    if (!this.enabled) {
      return this.inner.decide(request);
    }

    const frameId = computeDecisionFrameId(request);
    const repoRevision = this.getRepoRevision?.();
    const key = `${frameId}:${repoRevision ?? "none"}`;
    const now = Date.now();

    const existing = this.cache.get(key);
    if (existing) {
      if (now <= existing.expiresAt) {
        existing.hits += 1;
        existing.lastAccessedAt = now;
        this.hitsCount += 1;

        // Re-insert to refresh LRU order
        this.cache.delete(key);
        this.cache.set(key, existing);

        return {
          ...existing.result,
          identity: {
            ...existing.result.identity,
            cached: true,
          },
          usage: {
            ...existing.result.usage,
            latencyMs: 0,
          },
        };
      }
      // Expired entry
      this.cache.delete(key);
    }

    this.missesCount += 1;
    const result = await this.inner.decide(request);

    // Only cache successful non-empty decisions
    if (result.selected && result.selected.length > 0) {
      if (this.cache.size >= this.maxEntries) {
        this.evictOldest();
      }

      const entry: DecisionCacheEntry = {
        key,
        frameId,
        repoRevision,
        result,
        createdAt: now,
        expiresAt: now + this.ttlMs,
        hits: 0,
        lastAccessedAt: now,
      };
      this.cache.set(key, entry);
    }

    return result;
  }

  private evictOldest(): void {
    const oldestKey = this.cache.keys().next().value;
    if (oldestKey !== undefined) {
      this.cache.delete(oldestKey);
      this.evictionsCount += 1;
    }
  }

  stats(): DecisionCacheStats {
    const total = this.hitsCount + this.missesCount;
    return {
      entries: this.cache.size,
      hits: this.hitsCount,
      misses: this.missesCount,
      hitRate: total > 0 ? Number((this.hitsCount / total).toFixed(4)) : 0,
      evictions: this.evictionsCount,
    };
  }

  clear(): void {
    this.cache.clear();
    this.hitsCount = 0;
    this.missesCount = 0;
    this.evictionsCount = 0;
  }

  prune(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        pruned += 1;
      }
    }
    return pruned;
  }

  has(request: DecisionRequest): boolean {
    const frameId = computeDecisionFrameId(request);
    const repoRevision = this.getRepoRevision?.();
    const key = `${frameId}:${repoRevision ?? "none"}`;
    const entry = this.cache.get(key);
    return Boolean(entry && Date.now() <= entry.expiresAt);
  }

  dump(): DecisionCacheEntry[] {
    return Array.from(this.cache.values());
  }

  load(entries: DecisionCacheEntry[]): void {
    const now = Date.now();
    for (const entry of entries) {
      if (now <= entry.expiresAt) {
        this.cache.set(entry.key, entry);
      }
    }
  }
}
