import { describe, expect, it } from "vitest";
import { createLlmAdapter } from "@kitten/shared";
import { buildReviewPrompt } from "../src/prompt/build-prompt.js";

/**
 * Real DeepSeek integration test (KIT-012, US-012 AC-2).
 *
 * Skipped unless DEEPSEEK_API_KEY is set — CI does not run this; developers
 * run it explicitly. Validates the full factory → adapter → real API path,
 * which mocks cannot cover (request shape, tool use, structured output).
 */
const apiKey = process.env["DEEPSEEK_API_KEY"];

const describeIntegration = apiKey ? describe : describe.skip;

describeIntegration("DeepSeek real integration", () => {
  it("returns a schema-valid ReviewResult through the factory", async () => {
    const config = {
      provider: "anthropic" as const,
      baseUrl: "https://api.deepseek.com/anthropic",
      model: "deepseek-v4-flash",
      maxContextTokens: 100_000,
      maxOutputTokens: 8_000,
      maxFindings: 5,
      maxComplexity: 10,
      language: "en",
      trigger: "@reviewer",
      blocking: "comment_only" as const,
      skip: [],
      conventionsFile: "CLAUDE.md",
      rules: [],
    };

    const adapter = createLlmAdapter(config);

    const prompt = buildReviewPrompt(
      "diff --git a/src/utils.ts b/src/utils.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;",
      [{ path: "src/utils.ts", content: "export function add(a: number, b: number) { return a + b; }" }],
      config,
      "Conventions: no trailing semicolons.",
    );

    const result = await adapter.review({
      job: { repo: "org/repo", prNumber: 1, headRef: "h", baseRef: "b", sender: "test" },
      config,
      files: [{ path: "src/utils.ts", content: "export function add(a: number, b: number) { return a + b; }" }],
      diff: "diff --git a/src/utils.ts b/src/utils.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;",
      prompt,
    });

    // Schema-valid: findings is an array of valid Finding objects
    expect(Array.isArray(result.findings)).toBe(true);
    for (const f of result.findings) {
      expect(["critical", "high", "medium", "low"]).toContain(f.severity);
      expect(typeof f.file).toBe("string");
      expect(typeof f.line).toBe("number");
      expect(typeof f.finding).toBe("string");
    }
    expect(result.metadata.model).toBe("deepseek-v4-flash");
    expect(result.metadata.inputTokens).toBeGreaterThan(0);
  }, 60_000);
});
