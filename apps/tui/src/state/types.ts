import type { ExecuteTaskOptions } from "@lattice/service";
export type { WorkflowMode } from "@lattice/service";

export type DecisionReviewer = NonNullable<ExecuteTaskOptions["reviewer"]>;
export type ReviewRequest = Parameters<DecisionReviewer>[0];
export type ReviewOutcome = Awaited<ReturnType<DecisionReviewer>>;

export type ViewState = "idle" | "running" | "reviewing" | "diff";

export interface FeedItem {
  id: string;
  type: "info" | "task" | "event" | "evidence" | "result" | "doctor" | "runs" | "error" | "output";
  title?: string;
  text?: string;
  data?: unknown;
  timestamp: Date;
  tone?: "success" | "warning" | "muted";
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
  view: ViewState;
  workflow: import("@lattice/service").WorkflowMode;
  feed: FeedItem[];
  activeTask?: string;
  activePhase?: string;
  review?: ReviewState;
  diff?: DiffState;
}
