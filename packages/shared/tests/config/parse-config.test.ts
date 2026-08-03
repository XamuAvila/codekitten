import { describe, expect, it } from "vitest";

import { parseReviewerConfig } from "../../src/config/index.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { AppError } from "../../src/types/index.js";

const VALID_YAML = `
reviewer:
  language: pt-BR
  model: claude-opus-4-8
  max_context_tokens: 100000
  max_output_tokens: 16000
  max_findings: 5
  max_complexity: 12
  trigger: "@bot"
  blocking: request_changes
  skip:
    - "**/dist/**"
  conventions_file: AGENTS.md
  rules: []
`;

describe("parseReviewerConfig", () => {
  it("parseReviewerConfig parses valid YAML", () => {
    const config = parseReviewerConfig(VALID_YAML);

    expect(config).toEqual({
      provider: "anthropic",
      baseUrl: "https://api.deepseek.com/anthropic",
      language: "pt-BR",
      model: "claude-opus-4-8",
      maxContextTokens: 100000,
      maxOutputTokens: 16000,
      maxFindings: 5,
      maxComplexity: 12,
      trigger: "@bot",
      blocking: "request_changes",
      skip: ["**/dist/**"],
      conventionsFile: "AGENTS.md",
      rules: [],
    });
  });

  it("parseReviewerConfig returns defaults for empty input", () => {
    expect(parseReviewerConfig("")).toEqual(DEFAULT_CONFIG);
    expect(parseReviewerConfig("   \n  ")).toEqual(DEFAULT_CONFIG);
  });

  it("parseReviewerConfig returns defaults when reviewer key is absent", () => {
    expect(parseReviewerConfig("other_key: true\n")).toEqual(DEFAULT_CONFIG);
  });

  it("parseReviewerConfig throws VALIDATION for invalid YAML", () => {
    expect(() => parseReviewerConfig("reviewer: [unclosed")).toThrow(AppError);

    try {
      parseReviewerConfig("reviewer: [unclosed");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION");
    }
  });

  it("parseReviewerConfig throws VALIDATION for schema violations", () => {
    const invalid = `
reviewer:
  blocking: not_a_real_value
`;

    try {
      parseReviewerConfig(invalid);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION");
    }
  });

  it("parseReviewerConfig preserves skip patterns", () => {
    const config = parseReviewerConfig(`
reviewer:
  skip:
    - "**/Migrations/**"
    - "*.Designer.cs"
    - "**/*.snap"
`);

    expect(config.skip).toEqual(["**/Migrations/**", "*.Designer.cs", "**/*.snap"]);
  });

  it("parseReviewerConfig merges partial config over defaults", () => {
    const config = parseReviewerConfig("reviewer:\n  model: claude-haiku-4-5\n");

    expect(config.model).toBe("claude-haiku-4-5");
    expect(config.language).toBe(DEFAULT_CONFIG.language);
    expect(config.maxContextTokens).toBe(DEFAULT_CONFIG.maxContextTokens);
  });

  it("parseReviewerConfig parses max_findings and max_complexity", () => {
    const config = parseReviewerConfig(`
reviewer:
  max_findings: 3
  max_complexity: 8
`);

    expect(config.maxFindings).toBe(3);
    expect(config.maxComplexity).toBe(8);
  });

  it("parseReviewerConfig rejects legacy max_tokens key with VALIDATION", () => {
    const legacy = `
reviewer:
  max_tokens: 100000
`;

    try {
      parseReviewerConfig(legacy);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION");
    }
  });

  it("parseReviewerConfig returns defaults with v3 fields for empty YAML", () => {
    const config = parseReviewerConfig("");

    expect(config.maxContextTokens).toBe(DEFAULT_CONFIG.maxContextTokens);
    expect(config.maxOutputTokens).toBe(DEFAULT_CONFIG.maxOutputTokens);
    expect(config.maxFindings).toBe(DEFAULT_CONFIG.maxFindings);
    expect(config.maxComplexity).toBe(DEFAULT_CONFIG.maxComplexity);
  });
});
