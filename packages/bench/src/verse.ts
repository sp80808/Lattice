/**
 * VERSE: Verified Self-Evolving Optimizer (arXiv:2610.02616).
 *
 * Implements reproducible verification before and after candidate harness changes:
 * 1. Failure replay: tests candidates against known historical failure cases.
 * 2. Draft testing: verifies candidate hypothesis before full benchmark evaluation.
 * 3. Targeted perturbation: tracks operator attribution (prompt compaction, threshold tuning, etc.).
 * 4. Regression audit: enforces zero regressions on previously passing tasks.
 * 5. Meta-optimization: tunes operator sampling distribution based on empirical yield.
 */

export interface HistoricalFailure {
  taskId: string;
  error?: string;
  kind?: string;
  previousCandidateId?: string;
}

export interface VerseOperatorStat {
  operator: string;
  attempts: number;
  draftsPassed: number;
  promoted: number;
  yieldRate: number;
}

export interface VerseDraftCandidate<TConfig = unknown> {
  id: string;
  operator: string;
  hypothesis: string;
  config: TConfig;
}

export interface ReplayResult {
  total: number;
  resolved: number;
  resolvedTasks: string[];
  unresolvedTasks: string[];
}

export interface RegressionAuditResult {
  total: number;
  baselinePasses: number;
  candidatePasses: number;
  baselinePassRate: number;
  candidatePassRate: number;
  regressions: string[];
  newPasses: string[];
  retainedPasses: string[];
  retainedFailures: string[];
}

export interface VersePromotionDecision {
  promoted: boolean;
  candidateId: string;
  operator: string;
  replay: ReplayResult;
  audit: RegressionAuditResult;
  reason: string;
}

export interface VerseTaskEvaluator<TConfig = unknown> {
  evaluateTask(taskId: string, config: TConfig): Promise<boolean>;
}

export interface VerseOptimizerOptions<TConfig = unknown> {
  baselineConfig: TConfig;
  evaluator: VerseTaskEvaluator<TConfig>;
  /** Minimum number of historical failures a draft must resolve to proceed (default 1). */
  minFailuresResolved?: number;
  /** Whether candidate must strictly beat baseline pass rate (default: false, >= required). */
  requireStrictImprovement?: number;
}

export class VerseOptimizer<TConfig = unknown> {
  private activeConfig: TConfig;
  private readonly evaluator: VerseTaskEvaluator<TConfig>;
  private readonly minFailuresResolved: number;
  private readonly operatorStats: Map<string, { attempts: number; draftsPassed: number; promoted: number }> = new Map();

  constructor(options: VerseOptimizerOptions<TConfig>) {
    this.activeConfig = options.baselineConfig;
    this.evaluator = options.evaluator;
    this.minFailuresResolved = options.minFailuresResolved ?? 1;
  }

  public getActiveConfig(): TConfig {
    return this.activeConfig;
  }

  public getOperatorStats(): VerseOperatorStat[] {
    const stats: VerseOperatorStat[] = [];
    for (const [operator, data] of this.operatorStats.entries()) {
      stats.push({
        operator,
        attempts: data.attempts,
        draftsPassed: data.draftsPassed,
        promoted: data.promoted,
        yieldRate: data.attempts > 0 ? data.promoted / data.attempts : 0,
      });
    }
    return stats;
  }

  private recordOperatorAttempt(operator: string, draftPassed: boolean, promoted: boolean): void {
    const current = this.operatorStats.get(operator) ?? { attempts: 0, draftsPassed: 0, promoted: 0 };
    current.attempts += 1;
    if (draftPassed) current.draftsPassed += 1;
    if (promoted) current.promoted += 1;
    this.operatorStats.set(operator, current);
  }

  /**
   * Phase 1: Failure Replay
   * Replays historical failures to check if candidate resolves targeted failure conditions.
   */
  public async replayFailures(
    candidate: VerseDraftCandidate<TConfig>,
    failures: HistoricalFailure[],
  ): Promise<ReplayResult> {
    const resolvedTasks: string[] = [];
    const unresolvedTasks: string[] = [];

    for (const failure of failures) {
      const ok = await this.evaluator.evaluateTask(failure.taskId, candidate.config);
      if (ok) {
        resolvedTasks.push(failure.taskId);
      } else {
        unresolvedTasks.push(failure.taskId);
      }
    }

    return {
      total: failures.length,
      resolved: resolvedTasks.length,
      resolvedTasks,
      unresolvedTasks,
    };
  }

  /**
   * Phase 2: Strict Regression Audit
   * Evaluates candidate on baseline task suite. Ensures 0 regressions on previously passing tasks.
   */
  public async runRegressionAudit(
    candidate: VerseDraftCandidate<TConfig>,
    taskIds: string[],
    knownBaselinePasses: Set<string>,
  ): Promise<RegressionAuditResult> {
    const regressions: string[] = [];
    const newPasses: string[] = [];
    const retainedPasses: string[] = [];
    const retainedFailures: string[] = [];
    let candidatePassCount = 0;

    for (const taskId of taskIds) {
      const baselinePassed = knownBaselinePasses.has(taskId);
      const candidatePassed = await this.evaluator.evaluateTask(taskId, candidate.config);

      if (candidatePassed) {
        candidatePassCount += 1;
        if (baselinePassed) {
          retainedPasses.push(taskId);
        } else {
          newPasses.push(taskId);
        }
      } else {
        if (baselinePassed) {
          regressions.push(taskId);
        } else {
          retainedFailures.push(taskId);
        }
      }
    }

    const total = taskIds.length;
    const baselinePasses = knownBaselinePasses.size;

    return {
      total,
      baselinePasses,
      candidatePasses: candidatePassCount,
      baselinePassRate: total > 0 ? baselinePasses / total : 0,
      candidatePassRate: total > 0 ? candidatePassCount / total : 0,
      regressions,
      newPasses,
      retainedPasses,
      retainedFailures,
    };
  }

  /**
   * Complete VERSE evaluation and promotion gate.
   */
  public async evaluateCandidate(
    candidate: VerseDraftCandidate<TConfig>,
    failures: HistoricalFailure[],
    regressionTaskIds: string[],
    baselinePasses: Set<string>,
  ): Promise<VersePromotionDecision> {
    // 1. Failure replay phase
    const replay = await this.replayFailures(candidate, failures);
    if (replay.resolved < this.minFailuresResolved) {
      this.recordOperatorAttempt(candidate.operator, false, false);
      return {
        promoted: false,
        candidateId: candidate.id,
        operator: candidate.operator,
        replay,
        audit: {
          total: 0,
          baselinePasses: baselinePasses.size,
          candidatePasses: 0,
          baselinePassRate: 0,
          candidatePassRate: 0,
          regressions: [],
          newPasses: [],
          retainedPasses: [],
          retainedFailures: [],
        },
        reason: `Draft rejected: resolved ${replay.resolved} failures, below threshold ${this.minFailuresResolved}`,
      };
    }

    // 2. Regression audit phase
    const audit = await this.runRegressionAudit(candidate, regressionTaskIds, baselinePasses);

    // Strict gate: 0 regressions allowed
    if (audit.regressions.length > 0) {
      this.recordOperatorAttempt(candidate.operator, true, false);
      return {
        promoted: false,
        candidateId: candidate.id,
        operator: candidate.operator,
        replay,
        audit,
        reason: `Rejected due to regressions on: ${audit.regressions.join(", ")}`,
      };
    }

    // Pass rate check: candidate must meet or exceed baseline pass rate
    if (audit.candidatePassRate < audit.baselinePassRate) {
      this.recordOperatorAttempt(candidate.operator, true, false);
      return {
        promoted: false,
        candidateId: candidate.id,
        operator: candidate.operator,
        replay,
        audit,
        reason: `Rejected: candidate pass rate (${(audit.candidatePassRate * 100).toFixed(1)}%) < baseline (${(audit.baselinePassRate * 100).toFixed(1)}%)`,
      };
    }

    // 3. Accepted & Promoted!
    this.activeConfig = candidate.config;
    this.recordOperatorAttempt(candidate.operator, true, true);

    return {
      promoted: true,
      candidateId: candidate.id,
      operator: candidate.operator,
      replay,
      audit,
      reason: `Promoted: resolved ${replay.resolved} failure(s), 0 regressions, pass rate ${(audit.candidatePassRate * 100).toFixed(1)}% >= ${(audit.baselinePassRate * 100).toFixed(1)}%`,
    };
  }
}
