import { describe, expect, it } from "vitest";

import { parseReviewerConfig } from "../../src/config/index.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { AppError } from "../../src/types/index.js";

const VALID_YAML = `
reviewer:
  language: pt-BR
  model: claude-opus-4-8
  max_tokens: 100000
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
      language: "pt-BR",
      model: "claude-opus-4-8",
      maxTokens: 100000,
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
    expect(config.maxTokens).toBe(DEFAULT_CONFIG.maxTokens);
  });
});
