import type { ReviewerConfig } from "../types/index.js";

/**
 * Default configuration, used when .reviewer.yml is missing or empty.
 */
export const DEFAULT_CONFIG: ReviewerConfig = {
  language: "en",
  model: "claude-sonnet-5",
  maxTokens: 200_000,
  trigger: "@reviewer",
  blocking: "comment_only",
  skip: ["**/Migrations/**", "*.Designer.cs", "**/*.snap", "**/node_modules/**"],
  conventionsFile: "CLAUDE.md",
  rules: [],
};
