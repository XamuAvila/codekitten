import { describe, it, expect, vi, beforeEach } from "vitest";
import { dryRunAnalysis } from "../../src/analyzer/dry-run.js";
import type { DryRunContext } from "../../src/types.js";

describe("dryRunAnalysis", () => {
  const context: DryRunContext = {
    jobId: "test-job-1",
    repo: "org/repo",
    prNumber: 1,
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
    diff: { raw: "", filesChanged: 5, insertions: 20, deletions: 3 },
  };

  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("estimates tokens as ceil(chars/4)", () => {
    const result = dryRunAnalysis(context, 1000);
    expect(result.tokenEstimate).toBe(250);
  });

  it("rounds up with ceil for non-integer division", () => {
    const result = dryRunAnalysis(context, 401);
    // 401 / 4 = 100.25 → ceil = 101
    expect(result.tokenEstimate).toBe(101);
  });

  it("returns model from config", () => {
    const result = dryRunAnalysis(context, 100);
    expect(result.model).toBe("claude-sonnet-5");
  });

  it("includes file count in result", () => {
    const result = dryRunAnalysis(context, 0);
    expect(result.fileCount).toEqual({ total: 15, filtered: 12, skipped: 3 });
  });

  it("returns dryRun: true", () => {
    const result = dryRunAnalysis(context, 0);
    expect(result.dryRun).toBe(true);
  });

  it("logs with [reviewer] prefix", () => {
    dryRunAnalysis(context, 100);

    const allCalls = logSpy.mock.calls.flat();
    const reviewerLines = allCalls.filter(
      (arg) => typeof arg === "string" && arg.startsWith("[reviewer]"),
    );
    expect(reviewerLines.length).toBeGreaterThan(0);
    // Verify no [worker] prefix
    const workerLines = allCalls.filter(
      (arg) => typeof arg === "string" && arg.startsWith("[worker]"),
    );
    expect(workerLines).toHaveLength(0);
  });
});
