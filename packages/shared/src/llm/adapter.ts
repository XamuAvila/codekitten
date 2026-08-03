import type { ReviewJob, ReviewResult, ReviewerConfig } from "../types/index.js";

/**
 * ReviewFile — a changed file with its full content.
 */
export interface ReviewFile {
  readonly path: string;
  readonly content: string;
}

/**
 * ReviewContext — everything the LLM needs to review a PR:
 * the job, the resolved config, the changed files and (when available) the diff.
 */
export interface ReviewContext {
  readonly job: ReviewJob;
  readonly config: ReviewerConfig;
  readonly files: readonly ReviewFile[];
  readonly diff?: string;
}

/**
 * LLMAdapter — vendor-agnostic interface for review models.
 * Implementations (Anthropic, etc.) land in v2+.
 */
export interface LLMAdapter {
  review(context: ReviewContext): Promise<ReviewResult>;
}
