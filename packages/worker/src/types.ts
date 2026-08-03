import type { ReviewJob, ReviewerConfig } from "@kitten/shared";
import type { FileCount } from "./git/files.js";

export interface DryRunContext {
  readonly job: ReviewJob;
  readonly config: ReviewerConfig;
  readonly fileCount: FileCount;
}

export interface DryRunResult {
  readonly dryRun: true;
  readonly model: string;
  readonly tokenEstimate: number;
  readonly fileCount: FileCount;
}

export interface PipelineResult {
  readonly status: "completed" | "failed";
  readonly dryRun: boolean;
  readonly error?: string;
  readonly metadata: {
    readonly repo: string;
    readonly prNumber: number;
    readonly durationMs: number;
  };
}
