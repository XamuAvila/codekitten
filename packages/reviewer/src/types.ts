import type { Finding, ReviewerConfig } from "@kitten/shared";

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
  /** false = real LLM review (v3); kept for interface compatibility. */
  readonly dryRun: boolean;
  readonly diff?: DiffResult;
  readonly findings?: readonly Finding[];
  /** Built guardrailed prompt — KIT-017 reuses it for follow-up context. */
  readonly prompt?: { readonly system: string; readonly user: string };
  /** Resolved reviewer config — KIT-017 reuses it for follow-up LLM calls. */
  readonly llmConfig?: ReviewerConfig;
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
  /** Pre-formatted findings body (v3). When present, it replaces the dry-run summary. */
  readonly findingsBody?: string;
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
