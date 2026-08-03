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
  /** Pre-built guardrailed prompt (reviewer's buildReviewPrompt). When
   * absent, the adapter falls back to a minimal internal prompt. */
  readonly prompt?: { readonly system: string; readonly user: string };
}

/**
 * LLMAdapter — vendor-agnostic interface for review models.
 * Implementations (Anthropic, OpenAI) land in v3 (KIT-011/012).
 */
export interface LLMAdapter {
  /**
   * Run a full structured review. Returns Finding[] via the provider's
   * native structured-output mechanism (tool use / json_schema).
   */
  review(context: ReviewContext): Promise<ReviewResult>;

  /**
   * Free-text answer for follow-up questions (KIT-017). The review()
   * method returns Finding[] only, so follow-ups need a separate path.
   */
  respond(system: string, user: string, maxOutputTokens: number): Promise<string>;
}
