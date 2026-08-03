import { describe, expect, it, vi, afterEach } from "vitest";
import { AppError } from "../../src/types/errors.js";
import { resolveLlmKeyEnv, createLlmAdapter } from "../../src/llm/factory.js";
import { AnthropicAdapter } from "../../src/llm/anthropic-adapter.js";
import { OpenAIAdapter } from "../../src/llm/openai-adapter.js";

describe("resolveLlmKeyEnv", () => {
  it("maps known base_urls to the correct env name", () => {
    expect(resolveLlmKeyEnv("https://api.anthropic.com")).toBe("ANTHROPIC_API_KEY");
    expect(resolveLlmKeyEnv("https://api.deepseek.com/anthropic")).toBe("DEEPSEEK_API_KEY");
    expect(resolveLlmKeyEnv("https://api.openai.com")).toBe("OPENAI_API_KEY");
  });

  it("throws VALIDATION for unknown base_url", () => {
    try {
      resolveLlmKeyEnv("https://gateway.example.com");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION");
    }
  });
});

describe("createLlmAdapter", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns AnthropicAdapter for provider anthropic with the key from env", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "dk-key");
    const config = {
      provider: "anthropic" as const,
      baseUrl: "https://api.deepseek.com/anthropic",
      model: "deepseek-v4-flash",
      maxContextTokens: 1_000_000,
      maxOutputTokens: 16_000,
      maxFindings: 20,
      maxComplexity: 10,
      language: "en",
      trigger: "@reviewer",
      blocking: "comment_only" as const,
      skip: [],
      conventionsFile: "CLAUDE.md",
      rules: [],
    };

    const adapter = createLlmAdapter(config);

    expect(adapter).toBeInstanceOf(AnthropicAdapter);
  });

  it("returns OpenAIAdapter for provider openai with the key from env", () => {
    vi.stubEnv("OPENAI_API_KEY", "oa-key");
    const config = {
      provider: "openai" as const,
      baseUrl: "https://api.openai.com",
      model: "gpt-4o",
      maxContextTokens: 1_000_000,
      maxOutputTokens: 16_000,
      maxFindings: 20,
      maxComplexity: 10,
      language: "en",
      trigger: "@reviewer",
      blocking: "comment_only" as const,
      skip: [],
      conventionsFile: "CLAUDE.md",
      rules: [],
    };

    const adapter = createLlmAdapter(config);

    expect(adapter).toBeInstanceOf(OpenAIAdapter);
  });

  it("throws AUTH_FAILED when the key env is missing", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const config = {
      provider: "openai" as const,
      baseUrl: "https://api.openai.com",
      model: "gpt-4o",
      maxContextTokens: 1_000_000,
      maxOutputTokens: 16_000,
      maxFindings: 20,
      maxComplexity: 10,
      language: "en",
      trigger: "@reviewer",
      blocking: "comment_only" as const,
      skip: [],
      conventionsFile: "CLAUDE.md",
      rules: [],
    };

    expect(() => createLlmAdapter(config)).toThrow(AppError);
  });
});
