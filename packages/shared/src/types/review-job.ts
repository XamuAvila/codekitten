import { z } from "zod";

/**
 * ReviewJob — dispatcher → worker via BullMQ.
 */
export const ReviewJobSchema = z.object({
  /** Repository in "org/repo" form. */
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  headRef: z.string().min(1),
  baseRef: z.string().min(1),
  sender: z.string().min(1),
  isReReview: z.boolean(),
  /** v1: if absent, worker scans all files. v2+: populated from GitHub PR API. */
  changedFiles: z.array(z.string()).readonly().optional(),
});

export type ReviewJob = z.infer<typeof ReviewJobSchema>;

/**
 * Finding — a single review issue (LLM output, v2+).
 */
export const FindingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  file: z.string().min(1),
  line: z.number().int().positive(),
  finding: z.string().min(1),
  suggestion: z.string().optional(),
  ruleId: z.string().optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

/**
 * ReviewResult — output of a completed review.
 */
export const ReviewResultSchema = z.object({
  findings: z.array(FindingSchema).readonly(),
  contextChecked: z.array(z.string()).readonly(),
  conventionsStatus: z.array(z.string()).readonly(),
  metadata: z.object({
    model: z.string(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
  }),
});

export type ReviewResult = z.infer<typeof ReviewResultSchema>;
