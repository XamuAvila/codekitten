import { parse } from "yaml";
import { z } from "zod";

import { AppError } from "../types/index.js";
import type { ReviewerConfig } from "../types/index.js";
import { ReviewerConfigSchema, ReviewRuleSchema } from "../types/index.js";
import { DEFAULT_CONFIG } from "./defaults.js";

/**
 * Raw .reviewer.yml shape — snake_case keys under a top-level `reviewer` key.
 * Every field is optional; missing fields fall back to DEFAULT_CONFIG.
 */
// strictObject: unknown keys (e.g. legacy `max_tokens` from v2) must fail with
// VALIDATION, not be silently stripped — zod 4 z.object strips by default.
const RawReviewerSchema = z.strictObject({
  provider: z.enum(["anthropic", "openai"]).optional(),
  base_url: z.string().url().optional(),
  language: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  max_context_tokens: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  max_findings: z.number().int().positive().optional(),
  max_complexity: z.number().int().positive().optional(),
  trigger: z.string().min(1).optional(),
  blocking: z.enum(["comment_only", "request_changes"]).optional(),
  skip: z.array(z.string()).optional(),
  conventions_file: z.string().min(1).optional(),
  rules: z.array(ReviewRuleSchema).optional(),
  knowledge_top_k: z.number().int().positive().optional(),
});

const RawFileSchema = z
  .object({
    reviewer: RawReviewerSchema.optional(),
  })
  .loose();

type RawReviewer = z.infer<typeof RawReviewerSchema>;

function toValidationError(message: string, error: unknown): AppError {
  if (error instanceof z.ZodError) {
    return new AppError(
      "VALIDATION",
      message,
      error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    );
  }
  return new AppError("VALIDATION", message, [
    { message: error instanceof Error ? error.message : String(error) },
  ]);
}

function toReviewerConfig(raw: RawReviewer): ReviewerConfig {
  return ReviewerConfigSchema.parse({
    provider: raw.provider ?? DEFAULT_CONFIG.provider,
    baseUrl: raw.base_url ?? DEFAULT_CONFIG.baseUrl,
    language: raw.language ?? DEFAULT_CONFIG.language,
    model: raw.model ?? DEFAULT_CONFIG.model,
    maxContextTokens: raw.max_context_tokens ?? DEFAULT_CONFIG.maxContextTokens,
    maxOutputTokens: raw.max_output_tokens ?? DEFAULT_CONFIG.maxOutputTokens,
    maxFindings: raw.max_findings ?? DEFAULT_CONFIG.maxFindings,
    maxComplexity: raw.max_complexity ?? DEFAULT_CONFIG.maxComplexity,
    trigger: raw.trigger ?? DEFAULT_CONFIG.trigger,
    blocking: raw.blocking ?? DEFAULT_CONFIG.blocking,
    skip: raw.skip ?? DEFAULT_CONFIG.skip,
    conventionsFile: raw.conventions_file ?? DEFAULT_CONFIG.conventionsFile,
    rules: raw.rules ?? DEFAULT_CONFIG.rules,
    knowledgeTopK: raw.knowledge_top_k ?? DEFAULT_CONFIG.knowledgeTopK,
  });
}

/**
 * Parses .reviewer.yml content into a ReviewerConfig.
 * Empty/missing content or a missing `reviewer` key returns DEFAULT_CONFIG.
 * Invalid YAML or schema violations throw AppError with code VALIDATION.
 */
export function parseReviewerConfig(yamlContent: string): ReviewerConfig {
  if (yamlContent.trim() === "") {
    return DEFAULT_CONFIG;
  }

  let document: unknown;
  try {
    document = parse(yamlContent);
  } catch (error) {
    throw toValidationError("Invalid YAML in .reviewer.yml", error);
  }

  if (document === null || document === undefined) {
    return DEFAULT_CONFIG;
  }

  let rawFile: z.infer<typeof RawFileSchema>;
  try {
    rawFile = RawFileSchema.parse(document);
  } catch (error) {
    throw toValidationError("Invalid .reviewer.yml schema", error);
  }

  if (rawFile.reviewer === undefined) {
    return DEFAULT_CONFIG;
  }

  try {
    return toReviewerConfig(rawFile.reviewer);
  } catch (error) {
    throw toValidationError("Invalid .reviewer.yml schema", error);
  }
}
