import { z } from "zod";

/**
 * ReviewRule — custom review rule (pattern matching is v2+).
 */
export const ReviewRuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
});

export type ReviewRule = z.infer<typeof ReviewRuleSchema>;

/**
 * ReviewerConfig — parsed from .reviewer.yml (camelCase form).
 */
export const ReviewerConfigSchema = z.object({
  /** LLM provider SDK: anthropic (covers DeepSeek via baseUrl) or openai. */
  provider: z.enum(["anthropic", "openai"]),
  /** Provider endpoint; absent resolves to the provider's official URL. */
  baseUrl: z.string().url().optional(),
  language: z.string().min(1),
  model: z.string().min(1),
  /** Chunking budget — total prompt context allowed before multi-round review (KIT-014). */
  maxContextTokens: z.number().int().positive(),
  /** Per-request LLM output limit (DeepSeek caps at 384K). */
  maxOutputTokens: z.number().int().positive(),
  /** Max findings per review — guardrail against noisy reviews. */
  maxFindings: z.number().int().positive(),
  /** Cyclomatic complexity threshold to flag. */
  maxComplexity: z.number().int().positive(),
  trigger: z.string().min(1),
  blocking: z.enum(["comment_only", "request_changes"]),
  /** Glob patterns for files to skip. */
  skip: z.array(z.string()).readonly(),
  conventionsFile: z.string().min(1),
  rules: z.array(ReviewRuleSchema).readonly(),
});

export type ReviewerConfig = z.infer<typeof ReviewerConfigSchema>;
