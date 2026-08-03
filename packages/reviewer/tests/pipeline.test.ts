import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Track call order across mocks
const callOrder: string[] = [];

// --- Mock AnthropicAdapter (consumed from @kitten/shared dist) ---
// Mocking at the adapter level, not the SDK: the pipeline imports the adapter
// from @kitten/shared (dist build), and vi.mock on the transitive SDK import
// does not intercept the dist's resolution.
const { mockReview } = vi.hoisted(() => ({ mockReview: vi.fn() }));

vi.mock("@kitten/shared", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@kitten/shared")>();
  return {
    ...mod,
    AnthropicAdapter: class {
      review = mockReview;
      respond = vi.fn();
    },
  };
});

// --- Mock simple-git ---
const mockGitClone = vi.fn().mockImplementation(() => {
  callOrder.push("clone");
  return Promise.resolve(undefined);
});
const mockGitFetch = vi.fn().mockImplementation(() => {
  callOrder.push("fetch");
  return Promise.resolve(undefined);
});
const mockGitDiff = vi.fn().mockImplementation(() => {
  callOrder.push("diff");
  return Promise.resolve("mock diff");
});
const mockGitDiffSummary = vi.fn().mockImplementation(() => {
  callOrder.push("diffSummary");
  return Promise.resolve({ changed: 2, insertions: 10, deletions: 3 });
});

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => ({
    clone: mockGitClone,
    fetch: mockGitFetch,
    diff: mockGitDiff,
    diffSummary: mockGitDiffSummary,
  })),
}));

// --- Mock @octokit/rest ---
const mockListFiles = vi.fn().mockImplementation(() => {
  callOrder.push("listFiles");
  return Promise.resolve({
    data: [
      {
        filename: "src/app.ts",
        status: "modified",
        patch: "@@ -1 +1 @@",
        additions: 5,
        deletions: 2,
        changes: 7,
        blob_url: "https://github.com/o/r/blob/abc/src/app.ts",
        raw_url: "https://github.com/o/r/raw/abc/src/app.ts",
      },
    ],
  });
});

const mockCreateComment = vi.fn().mockImplementation(() => {
  callOrder.push("createComment");
  return Promise.resolve({ data: { id: 1, html_url: "https://github.com/o/r/pull/42#issuecomment-1" } });
});

vi.mock("@octokit/rest", () => ({
  Octokit: class MockOctokit {
    pulls = { listFiles: mockListFiles };
    issues = { createComment: mockCreateComment };
  },
}));

// --- Mock node:fs ---
const mockExistsSync = vi.fn(() => false);
const mockReadFileSync = vi.fn(() => "");
const mockReaddirSync = vi.fn(() => []);
const mockStatSync = vi.fn(() => ({ size: 0 }));
const mockRmSync = vi.fn();

vi.mock("node:fs", () => ({
  default: {
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
    statSync: (...args: unknown[]) => mockStatSync(...args),
    rmSync: (...args: unknown[]) => mockRmSync(...args),
  },
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  statSync: (...args: unknown[]) => mockStatSync(...args),
  rmSync: (...args: unknown[]) => mockRmSync(...args),
}));

import { runPipeline } from "../src/pipeline.js";
import type { PipelineConfig } from "../src/types.js";

const baseConfig: PipelineConfig = {
  jobId: "test-job-1",
  repo: "octocat/Hello-World",
  prNumber: 42,
  headRef: "feat/x",
  baseRef: "main",
  token: "test-token",
  redisUrl: "redis://localhost:6379",
  skipPatterns: [],
};

function llmReviewResult(findings: unknown[] = []) {
  return {
    findings,
    contextChecked: [],
    conventionsStatus: [],
    metadata: { model: "deepseek-v4-flash", inputTokens: 100, outputTokens: 50, durationMs: 0 },
  };
}

describe("runPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;

    // Defaults: fs.existsSync returns false
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
    mockStatSync.mockReturnValue({ size: 0 });
    mockReview.mockResolvedValue(llmReviewResult([]));

    // LLM key env — DEFAULT_CONFIG points at DeepSeek, so the key env is DEEPSEEK
    vi.stubEnv("DEEPSEEK_API_KEY", "test-llm-key");

    // Reset git mocks to default behavior
    mockGitClone.mockImplementation(() => {
      callOrder.push("clone");
      return Promise.resolve(undefined);
    });
    mockGitFetch.mockImplementation(() => {
      callOrder.push("fetch");
      return Promise.resolve(undefined);
    });
    mockGitDiff.mockImplementation(() => {
      callOrder.push("diff");
      return Promise.resolve("mock diff");
    });
    mockGitDiffSummary.mockImplementation(() => {
      callOrder.push("diffSummary");
      return Promise.resolve({ changed: 2, insertions: 10, deletions: 3 });
    });
    mockListFiles.mockImplementation(() => {
      callOrder.push("listFiles");
      return Promise.resolve({
        data: [
          {
            filename: "src/app.ts",
            status: "modified",
            patch: "@@ -1 +1 @@",
            additions: 5,
            deletions: 2,
            changes: 7,
            blob_url: "https://github.com/o/r/blob/abc/src/app.ts",
            raw_url: "https://github.com/o/r/raw/abc/src/app.ts",
          },
        ],
      });
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("calls steps in order: clone → diff → fetchPrFiles → LLM → comment", async () => {
    await runPipeline(baseConfig);

    expect(callOrder.indexOf("clone")).toBeLessThan(callOrder.indexOf("diff"));
    expect(callOrder.indexOf("diff")).toBeLessThan(callOrder.indexOf("listFiles"));
    expect(callOrder.indexOf("listFiles")).toBeLessThan(callOrder.indexOf("createComment"));
  });

  it("calls the LLM exactly once with the guardrailed prompt", async () => {
    await runPipeline(baseConfig);

    expect(mockReview).toHaveBeenCalledTimes(1);
    const [context] = mockReview.mock.calls[0];
    expect(context.prompt.system).toMatch(/never commit/i);
    expect(context.config.model).toBe("deepseek-v4-flash");
  });

  it("returns completed PipelineResult with findings and prompt", async () => {
    mockReview.mockResolvedValue(
      llmReviewResult([
        {
          severity: "high",
          file: "src/app.ts",
          line: 1,
          finding: "Unhandled error",
          suggestion: "Wrap in try/catch",
        },
      ]),
    );

    const result = await runPipeline(baseConfig);

    expect(result.status).toBe("completed");
    expect(result.dryRun).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings![0]).toMatchObject({
      severity: "high",
      file: "src/app.ts",
      line: 1,
      finding: "Unhandled error",
    });
    expect(result.prompt).toBeDefined();
    expect(result.prompt!.system).toMatch(/never commit/i);
  });

  it("posts a findings table comment, not the v2 dry-run placeholder", async () => {
    mockReview.mockResolvedValue(
      llmReviewResult([
        { severity: "low", file: "src/app.ts", line: 2, finding: "Minor issue" },
      ]),
    );

    await runPipeline(baseConfig);

    expect(mockCreateComment).toHaveBeenCalledTimes(1);
    const body = (mockCreateComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain("[KITTEN-TEST]");
    expect(body).not.toContain("DRY RUN");
    expect(body).toContain("| Severity");
  });

  it("includes diff result in pipeline result", async () => {
    const result = await runPipeline(baseConfig);

    expect(result.status).toBe("completed");
    expect(result.diff).toBeDefined();
    expect(result.diff!.filesChanged).toBe(2);
    expect(result.diff!.insertions).toBe(10);
    expect(result.diff!.deletions).toBe(3);
  });

  it("cleans up clone dir on success", async () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path === `/tmp/clones/${baseConfig.jobId}`) return true;
      return false;
    });

    await runPipeline(baseConfig);

    expect(mockRmSync).toHaveBeenCalledWith(
      `/tmp/clones/${baseConfig.jobId}`,
      { recursive: true, force: true },
    );
  });

  it("cleans up clone dir on failure", async () => {
    mockGitClone.mockRejectedValue(new Error("clone failed"));
    mockExistsSync.mockReturnValue(true);

    await runPipeline(baseConfig);

    expect(mockRmSync).toHaveBeenCalledWith(
      `/tmp/clones/${baseConfig.jobId}`,
      { recursive: true, force: true },
    );
  });

  it("returns failed PipelineResult on clone error", async () => {
    mockGitClone.mockRejectedValue(new Error("Repository not found"));

    const result = await runPipeline(baseConfig);

    expect(result.status).toBe("failed");
    expect(result.error).toBeDefined();
  });

  it("returns failed PipelineResult when the LLM call fails permanently", async () => {
    vi.useFakeTimers();
    mockReview.mockRejectedValue(new Error("model unavailable"));

    const promise = runPipeline(baseConfig);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;
    vi.useRealTimers();

    expect(result.status).toBe("failed");
    expect(result.error).toContain("model unavailable");
    expect(mockReview).toHaveBeenCalledTimes(3);
  });

  it("does not retry auth failures — maps to AUTH_FAILED", async () => {
    const authError = Object.assign(new Error("401 invalid api key"), { status: 401 });
    mockReview.mockRejectedValue(authError);

    const result = await runPipeline(baseConfig);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("AUTH_FAILED");
    expect(mockReview).toHaveBeenCalledTimes(1);
  });

  it("reads .reviewer.yml from cloned repo", async () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith(".reviewer.yml")) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(
      "reviewer:\n  language: pt\n  model: gpt-4\n",
    );

    const result = await runPipeline(baseConfig);

    expect(result.status).toBe("completed");
    expect(mockReadFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".reviewer.yml"),
      "utf-8",
    );
  });

  it("uses DEFAULT_CONFIG when .reviewer.yml missing", async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await runPipeline(baseConfig);

    expect(result.status).toBe("completed");
  });
});
