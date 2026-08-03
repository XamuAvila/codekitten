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

export interface ReviewCommentData {
  readonly repo: string;
  readonly prNumber: number;
  readonly fileCount: { readonly total: number; readonly analyzed: number; readonly skipped: number };
  readonly tokenEstimate: number;
  readonly model: string;
  readonly diff: { readonly insertions: number; readonly deletions: number };
}

export interface PrMetadata {
  readonly title: string;
  readonly author: string;
  readonly state: "open" | "closed" | "merged";
}

export interface CommentResult {
  readonly id: number;
  readonly url: string;
}
