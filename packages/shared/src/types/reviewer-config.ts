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
  language: z.string().min(1),
  model: z.string().min(1),
  maxTokens: z.number().int().positive(),
  trigger: z.string().min(1),
  blocking: z.enum(["comment_only", "request_changes"]),
  /** Glob patterns for files to skip. */
  skip: z.array(z.string()).readonly(),
  conventionsFile: z.string().min(1),
  rules: z.array(ReviewRuleSchema).readonly(),
});

export type ReviewerConfig = z.infer<typeof ReviewerConfigSchema>;
