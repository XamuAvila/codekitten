import type { ReviewerConfig } from "@kitten/shared";

export interface CloneResult {
  readonly dir: string;
  readonly sizeBytes: number;
}

export interface DiffResult {
  readonly raw: string;
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface FileCount {
  readonly total: number;
  readonly filtered: number;
  readonly skipped: number;
}

export interface DryRunContext {
  readonly jobId: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly config: ReviewerConfig;
  readonly fileCount: FileCount;
  readonly diff: DiffResult;
}

export interface DryRunResult {
  readonly dryRun: true;
  readonly model: string;
  readonly tokenEstimate: number;
  readonly fileCount: FileCount;
}

export interface PipelineConfig {
  readonly jobId: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headRef: string;
  readonly baseRef: string;
  readonly token: string;
  readonly redisUrl: string;
  readonly skipPatterns: readonly string[];
}

export interface PipelineResult {
  readonly status: "completed" | "failed";
  readonly dryRun: boolean;
  readonly diff?: DiffResult;
  readonly error?: string;
  readonly metadata: {
    readonly repo: string;
    readonly prNumber: number;
    readonly durationMs: number;
  };
}
