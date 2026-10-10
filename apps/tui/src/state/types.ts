import type { RunEvent, RunResult } from "@lattice/protocol";
import type { ExecuteTaskOptions } from "@lattice/service";

export type DecisionReviewer = NonNullable<ExecuteTaskOptions["reviewer"]>;
export type ReviewRequest = Parameters<DecisionReviewer>[0];
export type ReviewOutcome = Awaited<ReturnType<DecisionReviewer>>;

export type TuiMode = "idle" | "running" | "reviewing" | "diff";

export interface FeedItem {
  id: string;
  type: "info" | "task" | "event" | "evidence" | "result" | "doctor" | "runs" | "error" | "output";
  title?: string;
  text?: string;
  data?: unknown;
  timestamp: Date;
}

export interface ReviewState {
  request: ReviewRequest;
  resolve: (response: ReviewOutcome) => void;
}

export interface DiffState {
  title: string;
  diffText: string;
}

export interface TuiSessionState {
  cwd: string;
  configPath?: string;
  mode: TuiMode;
  feed: FeedItem[];
  activeTask?: string;
  activePhase?: string;
  review?: ReviewState;
  diff?: DiffState;
}
