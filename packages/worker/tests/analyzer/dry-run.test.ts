import { describe, it, expect } from "vitest";
import { dryRunAnalysis } from "../../src/analyzer/dry-run.js";
import type { DryRunContext } from "../../src/types.js";

describe("dryRunAnalysis", () => {
  const context: DryRunContext = {
    job: {
      repo: "org/repo",
      prNumber: 1,
      headRef: "feat/x",
      baseRef: "main",
      sender: "dev",
      isReReview: false,
    },
    config: {
      language: "en",
      model: "claude-sonnet-5",
      maxTokens: 200_000,
      trigger: "@reviewer",
      blocking: "comment_only",
      skip: [],
      conventionsFile: "CLAUDE.md",
      rules: [],
    },
    fileCount: { total: 15, filtered: 12, skipped: 3 },
  };

  it("estimates tokens as ceil(totalChars / 4)", () => {
    const result = dryRunAnalysis(context, 2000);

    // 2000 / 4 = 500 → ceil = 500
    expect(result.tokenEstimate).toBe(500);
  });

  it("returns model from config", () => {
    const result = dryRunAnalysis(context, 100);
    expect(result.model).toBe("claude-sonnet-5");
  });

  it("returns fileCount from context", () => {
    const result = dryRunAnalysis(context, 0);
    expect(result.fileCount).toEqual({ total: 15, filtered: 12, skipped: 3 });
  });

  it("returns dryRun: true", () => {
    const result = dryRunAnalysis(context, 0);
    expect(result.dryRun).toBe(true);
  });

  it("tokenEstimate rounds up with ceil", () => {
    const result = dryRunAnalysis(context, 401);
    // 401 / 4 = 100.25 → ceil = 101
    expect(result.tokenEstimate).toBe(101);
  });
});
