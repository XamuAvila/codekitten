import type { ReviewerConfig } from "../types/index.js";

/**
 * Default configuration, used when .reviewer.yml is missing or empty.
 */
export const DEFAULT_CONFIG: ReviewerConfig = {
  provider: "anthropic",
  // Product default is DeepSeek via the Anthropic-compatible endpoint
  // (user decision — cheap, "config mais fácil"). A .reviewer.yml without
  // base_url resolves to the provider's official URL instead (KIT-012).
  baseUrl: "https://api.deepseek.com/anthropic",
  language: "en",
  model: "deepseek-v4-flash",
  maxContextTokens: 1_000_000,
  maxOutputTokens: 16_000,
  maxFindings: 20,
  maxComplexity: 10,
  trigger: "@reviewer",
  blocking: "comment_only",
  skip: ["**/Migrations/**", "*.Designer.cs", "**/*.snap", "**/node_modules/**"],
  conventionsFile: "CLAUDE.md",
  rules: [],
  knowledgeTopK: 5,
};
