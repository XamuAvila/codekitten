import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Track call order across mocks
const callOrder: string[] = [];

// --- Mock createLlmAdapter + adapters (consumed from @kitten/shared dist) ---
// Mocking at the adapter level, not the SDK: the pipeline imports from
// @kitten/shared (dist build), and vi.mock on the transitive SDK import does
// not intercept the dist's resolution.
const { mockCreateLlmAdapter, mockReview, mockCreateKnowledgeClient } = vi.hoisted(() => ({
  mockCreateLlmAdapter: vi.fn(),
  mockReview: vi.fn(),
  mockCreateKnowledgeClient: vi.fn(),
}));

vi.mock("@kitten/shared", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@kitten/shared")>();
  return {
    ...mod,
    createLlmAdapter: mockCreateLlmAdapter,
    createKnowledgeClient: mockCreateKnowledgeClient,
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

const mockCreateReview = vi.fn().mockResolvedValue({ data: { id: 1 } });

vi.mock("@octokit/rest", () => ({
  Octokit: class MockOctokit {
    pulls = { listFiles: mockListFiles, createReview: mockCreateReview };
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
    mockCreateKnowledgeClient.mockReturnValue(undefined);
    mockCreateLlmAdapter.mockReturnValue({ review: mockReview, respond: vi.fn() });

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

  it("builds the adapter via createLlmAdapter with config and calls the LLM once", async () => {
    await runPipeline(baseConfig);

    expect(mockCreateLlmAdapter).toHaveBeenCalledTimes(1);
    const [adapterConfig] = mockCreateLlmAdapter.mock.calls[0];
    expect(adapterConfig.provider).toBe("anthropic");
    expect(adapterConfig.model).toBe("deepseek-v4-flash");

    expect(mockReview).toHaveBeenCalledTimes(1);
    const [context] = mockReview.mock.calls[0];
    expect(context.prompt.system).toMatch(/never commit/i);
  });

  it("fails with the schema validation error when the single chunk is invalid", async () => {
    mockReview.mockRejectedValue(new Error("Invalid findings from LLM: ..."));
    vi.useFakeTimers();

    const promise = runPipeline(baseConfig);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;
    vi.useRealTimers();

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Invalid findings from LLM");
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

  it("posts a PR review via createReview, not a dry-run placeholder comment", async () => {
    mockReview.mockResolvedValue(
      llmReviewResult([
        { severity: "low", file: "src/app.ts", line: 2, finding: "Minor issue" },
      ]),
    );

    await runPipeline(baseConfig);

    // PR review (inline) replaced the issue comment for findings
    expect(mockCreateReview).toHaveBeenCalledTimes(1);
    expect(mockCreateComment).not.toHaveBeenCalled();
    const [params] = mockCreateReview.mock.calls[0];
    expect(params.event).toBe("COMMENT");
    expect(params).not.toHaveProperty("state");
    expect(params.body).not.toContain("DRY RUN");
    expect(params.body).toContain("[KITTEN-TEST]");
  });

  it("submits REQUEST_CHANGES when .reviewer.yml sets blocking: request_changes", async () => {
    mockExistsSync.mockImplementation((path: unknown) =>
      typeof path === "string" && path.endsWith(".reviewer.yml"),
    );
    mockReadFileSync.mockReturnValue("reviewer:\n  blocking: request_changes\n");
    mockReview.mockResolvedValue(
      llmReviewResult([{ severity: "high", file: "src/app.ts", line: 1, finding: "Bug" }]),
    );

    await runPipeline(baseConfig);

    expect(mockCreateReview).toHaveBeenCalledTimes(1);
    expect(mockCreateReview.mock.calls[0][0].event).toBe("REQUEST_CHANGES");
  });

  it("never blocks a PR that produced zero findings", async () => {
    mockExistsSync.mockImplementation((path: unknown) =>
      typeof path === "string" && path.endsWith(".reviewer.yml"),
    );
    mockReadFileSync.mockReturnValue("reviewer:\n  blocking: request_changes\n");
    mockReview.mockResolvedValue(llmReviewResult([]));
    mockCreateKnowledgeClient.mockReturnValue(undefined);

    await runPipeline(baseConfig);

    expect(mockCreateReview).not.toHaveBeenCalled();
    expect(mockCreateComment).toHaveBeenCalledTimes(1);
  });

  it("never blocks a PR whose review was aborted before any chunk ran", async () => {
    mockExistsSync.mockImplementation((path: unknown) =>
      typeof path === "string" && path.endsWith(".reviewer.yml"),
    );
    mockReadFileSync.mockReturnValue("reviewer:\n  blocking: request_changes\n");

    const controller = new AbortController();
    controller.abort();

    await runPipeline(baseConfig, { signal: controller.signal });

    expect(mockCreateReview).not.toHaveBeenCalled();
  });

  it("posts an issue comment (no PR review) when there are zero findings", async () => {
    mockReview.mockResolvedValue(llmReviewResult([]));
    mockCreateKnowledgeClient.mockReturnValue(undefined);

    await runPipeline(baseConfig);

    // Empty findings: no createReview crash, comment states no issues found
    expect(mockCreateComment).toHaveBeenCalledTimes(1);
    const body = (mockCreateComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toMatch(/no issues found/i);
    expect(mockCreateReview).not.toHaveBeenCalled();
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

  it("fails the review when the LLM call fails permanently (single chunk)", async () => {
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

  it("makes a single LLM call when files fit the budget", async () => {
    await runPipeline(baseConfig);

    expect(mockReview).toHaveBeenCalledTimes(1);
  });

  it("makes one LLM call per chunk when over the budget", async () => {
    // Tiny budget + multiple files → multiple chunks
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith(".reviewer.yml")) return true;
      if (typeof path === "string" && (path.endsWith("src/app.ts") || path.endsWith("src/utils.ts"))) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.endsWith(".reviewer.yml")) return "reviewer:\n  max_context_tokens: 10\n";
      if (path.endsWith("src/app.ts")) return "export const app = () => 1;";
      return "export const util = () => 2;";
    });
    mockListFiles.mockResolvedValue({
      data: [
        { filename: "src/app.ts", status: "modified", patch: "@@ -1 +1 @@", additions: 1, deletions: 0, changes: 1, blob_url: "u", raw_url: "u" },
        { filename: "src/utils.ts", status: "modified", patch: "@@ -1 +1 @@", additions: 1, deletions: 0, changes: 1, blob_url: "u", raw_url: "u" },
      ],
    });

    mockReview.mockResolvedValue(llmReviewResult([]));
    mockCreateKnowledgeClient.mockReturnValue(undefined);

    await runPipeline(baseConfig);

    expect(mockReview.mock.calls.length).toBeGreaterThan(1);
  });

  it("consolidates findings across chunks and dedupes by file:line", async () => {
    // Tiny budget + multiple files → multiple chunks, each reporting the same finding
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith(".reviewer.yml")) return true;
      if (typeof path === "string" && (path.endsWith("src/app.ts") || path.endsWith("src/utils.ts"))) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.endsWith(".reviewer.yml")) return "reviewer:\n  max_context_tokens: 10\n";
      if (path.endsWith("src/app.ts")) return "export const app = () => 1;";
      return "export const util = () => 2;";
    });
    mockListFiles.mockResolvedValue({
      data: [
        { filename: "src/app.ts", status: "modified", patch: "@@ -1 +1 @@", additions: 1, deletions: 0, changes: 1, blob_url: "u", raw_url: "u" },
        { filename: "src/utils.ts", status: "modified", patch: "@@ -1 +1 @@", additions: 1, deletions: 0, changes: 1, blob_url: "u", raw_url: "u" },
      ],
    });

    mockReview.mockImplementation(async () => llmReviewResult([
      { severity: "high", file: "src/app.ts", line: 1, finding: "Bug" },
    ]));

    const result = await runPipeline(baseConfig);

    expect(mockReview.mock.calls.length).toBeGreaterThan(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings![0].finding).toBe("Bug");
  });

  it("ignoreBudget skips chunking — single call with all files, no budget question", async () => {
    // Over-budget setup
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith(".reviewer.yml")) return true;
      if (typeof path === "string" && (path.endsWith("src/app.ts") || path.endsWith("src/utils.ts"))) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.endsWith(".reviewer.yml")) return "reviewer:\n  max_context_tokens: 10\n";
      if (path.endsWith("src/app.ts")) return "export const app = () => 1;";
      return "export const util = () => 2;";
    });
    mockListFiles.mockResolvedValue({
      data: [
        { filename: "src/app.ts", status: "modified", patch: "@@ -1 +1 @@", additions: 1, deletions: 0, changes: 1, blob_url: "u", raw_url: "u" },
        { filename: "src/utils.ts", status: "modified", patch: "@@ -1 +1 @@", additions: 1, deletions: 0, changes: 1, blob_url: "u", raw_url: "u" },
      ],
    });
    mockReview.mockResolvedValue(llmReviewResult([]));
    mockCreateKnowledgeClient.mockReturnValue(undefined);

    const result = await runPipeline(baseConfig, { ignoreBudget: true });

    expect(mockReview).toHaveBeenCalledTimes(1);
    const [context] = mockReview.mock.calls[0];
    expect(context.files).toHaveLength(2); // all files in one call
    // no budget question comment
    const bodies = mockCreateComment.mock.calls.map((c) => (c[0] as { body: string }).body);
    expect(bodies.some((b) => b.match(/exceeds the token budget/i))).toBe(false);
    expect(result.status).toBe("completed");
  });

  it("aborts remaining chunks when the signal is aborted", async () => {
    // Over-budget setup with 2 files → 2 chunks
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith(".reviewer.yml")) return true;
      if (typeof path === "string" && (path.endsWith("src/app.ts") || path.endsWith("src/utils.ts"))) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.endsWith(".reviewer.yml")) return "reviewer:\n  max_context_tokens: 10\n";
      if (path.endsWith("src/app.ts")) return "export const app = () => 1;";
      return "export const util = () => 2;";
    });
    mockListFiles.mockResolvedValue({
      data: [
        { filename: "src/app.ts", status: "modified", patch: "@@ -1 +1 @@", additions: 1, deletions: 0, changes: 1, blob_url: "u", raw_url: "u" },
        { filename: "src/utils.ts", status: "modified", patch: "@@ -1 +1 @@", additions: 1, deletions: 0, changes: 1, blob_url: "u", raw_url: "u" },
      ],
    });

    let callCount = 0;
    mockReview.mockImplementation(async () => {
      callCount += 1;
      return llmReviewResult([]);
    });

    const controller = new AbortController();
    controller.abort(); // aborted before any call

    await runPipeline(baseConfig, { signal: controller.signal });

    expect(callCount).toBe(0);
  });

  it("passes .reviewer.yml rules into the prompt sent to the LLM", async () => {
    mockExistsSync.mockImplementation((path: unknown) =>
      typeof path === "string" && path.endsWith(".reviewer.yml"),
    );
    mockReadFileSync.mockReturnValue(
      "reviewer:\n  rules:\n    - id: no-raw-sql\n      description: Use the query builder.\n",
    );

    await runPipeline(baseConfig);

    const [context] = mockReview.mock.calls[0];
    expect(context.prompt.user).toContain("- no-raw-sql: Use the query builder.");
  });

  it("strips finding rule attribution that matches no rule in .reviewer.yml", async () => {
    mockExistsSync.mockImplementation((path: unknown) =>
      typeof path === "string" && path.endsWith(".reviewer.yml"),
    );
    mockReadFileSync.mockReturnValue(
      "reviewer:\n  rules:\n    - id: no-raw-sql\n      description: Use the query builder.\n",
    );
    mockReview.mockResolvedValue(
      llmReviewResult([
        { severity: "high", file: "src/app.ts", line: 1, finding: "Raw SQL", ruleId: "no-raw-sql" },
        { severity: "low", file: "src/app.ts", line: 2, finding: "Other", ruleId: "invented-rule" },
      ]),
    );

    const result = await runPipeline(baseConfig);

    expect(result.findings).toHaveLength(2);
    expect(result.findings![0].ruleId).toBe("no-raw-sql");
    expect(result.findings![1].ruleId).toBeUndefined();
  });

  it("keeps the no-issues notice in English when another language is configured", async () => {
    mockExistsSync.mockImplementation((path: unknown) =>
      typeof path === "string" && path.endsWith(".reviewer.yml"),
    );
    mockReadFileSync.mockReturnValue("reviewer:\n  language: pt\n");
    mockReview.mockResolvedValue(llmReviewResult([]));
    mockCreateKnowledgeClient.mockReturnValue(undefined);

    await runPipeline(baseConfig);

    const body = (mockCreateComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toMatch(/no issues found/i);
  });

  it("keeps the budget notice in English when another language is configured", async () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith(".reviewer.yml")) return true;
      if (typeof path === "string" && (path.endsWith("src/app.ts") || path.endsWith("src/utils.ts"))) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.endsWith(".reviewer.yml")) return "reviewer:\n  language: pt\n  max_context_tokens: 10\n";
      if (path.endsWith("src/app.ts")) return "export const app = () => 1;";
      return "export const util = () => 2;";
    });
    mockListFiles.mockResolvedValue({
      data: [
        { filename: "src/app.ts", status: "modified", patch: "@@ -1 +1 @@", additions: 1, deletions: 0, changes: 1, blob_url: "u", raw_url: "u" },
        { filename: "src/utils.ts", status: "modified", patch: "@@ -1 +1 @@", additions: 1, deletions: 0, changes: 1, blob_url: "u", raw_url: "u" },
      ],
    });
    mockReview.mockResolvedValue(llmReviewResult([]));
    mockCreateKnowledgeClient.mockReturnValue(undefined);

    await runPipeline(baseConfig);

    const bodies = mockCreateComment.mock.calls.map((c) => (c[0] as { body: string }).body);
    expect(bodies.some((b) => b.match(/exceeds the token budget/i))).toBe(true);
  });

  it("posts a budget question comment when over the budget", async () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith(".reviewer.yml")) return true;
      if (typeof path === "string" && (path.endsWith("src/app.ts") || path.endsWith("src/utils.ts"))) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.endsWith(".reviewer.yml")) return "reviewer:\n  max_context_tokens: 10\n";
      if (path.endsWith("src/app.ts")) return "export const app = () => 1;";
      return "export const util = () => 2;";
    });
    mockListFiles.mockResolvedValue({
      data: [
        { filename: "src/app.ts", status: "modified", patch: "@@ -1 +1 @@", additions: 1, deletions: 0, changes: 1, blob_url: "u", raw_url: "u" },
        { filename: "src/utils.ts", status: "modified", patch: "@@ -1 +1 @@", additions: 1, deletions: 0, changes: 1, blob_url: "u", raw_url: "u" },
      ],
    });

    mockReview.mockResolvedValue(llmReviewResult([]));
    mockCreateKnowledgeClient.mockReturnValue(undefined);

    await runPipeline(baseConfig);

    expect(mockCreateComment).toHaveBeenCalled();
    const bodies = mockCreateComment.mock.calls.map((c) => (c[0] as { body: string }).body);
    expect(bodies.some((b) => b.match(/exceeds the token budget/i))).toBe(true);
    expect(bodies.some((b) => b.match(/force/i))).toBe(true);
  });

  describe("agentic branch (.reviewer-mcp.json, KIT-023)", () => {
    const FINDING = { severity: "high", file: "src/app.ts", line: 1, finding: "Bug found" };

    function enableAgenticFs(mcpJson: string) {
      mockExistsSync.mockImplementation((path: unknown) => {
        if (typeof path === "string" && path.endsWith(".reviewer-mcp.json")) return true;
        if (typeof path === "string" && path.endsWith("src/app.ts")) return true;
        return false;
      });
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.endsWith(".reviewer-mcp.json")) return mcpJson;
        return "export const app = () => 1;";
      });
    }

    it("enabled → runs the agentic loop and posts findings via postPrReview", async () => {
      enableAgenticFs(JSON.stringify({ enabled: true }));
      const mockExplore = vi.fn().mockResolvedValue({
        toolUses: [{ name: "report_findings", input: { findings: [FINDING] } }],
        metadata: { inputTokens: 10, outputTokens: 5, durationMs: 1 },
      });
      mockCreateLlmAdapter.mockReturnValue({ review: mockReview, respond: vi.fn(), explore: mockExplore });

      const result = await runPipeline(baseConfig);

      expect(result.status).toBe("completed");
      expect(mockExplore).toHaveBeenCalled();
      expect(mockReview).not.toHaveBeenCalled();
      expect(mockCreateReview).toHaveBeenCalled();
      expect(result.mcpConfig?.enabled).toBe(true);
      expect(result.metadata.toolCalls).toBe(0);
      expect(result.findings).toHaveLength(1);
    });

    it("budget-exhausted agentic review posts the force invitation with the tool-call count (US-026)", async () => {
      enableAgenticFs(JSON.stringify({ enabled: true, maxTurns: 1 }));
      // Turn 1 explores (consumes the only turn); finalize turn reports.
      const mockExplore = vi
        .fn()
        .mockResolvedValueOnce({
          toolUses: [{ name: "read_file", input: { path: "src/app.ts" } }],
          metadata: { inputTokens: 10, outputTokens: 5, durationMs: 1 },
        })
        .mockResolvedValueOnce({
          toolUses: [{ name: "report_findings", input: { findings: [FINDING] } }],
          metadata: { inputTokens: 10, outputTokens: 5, durationMs: 1 },
        });
      mockCreateLlmAdapter.mockReturnValue({ review: mockReview, respond: vi.fn(), explore: mockExplore });

      const result = await runPipeline(baseConfig);

      expect(result.status).toBe("completed");
      expect(result.metadata.toolCalls).toBe(1);
      const bodies = mockCreateComment.mock.calls.map((c) => (c[0] as { body: string }).body);
      expect(bodies.some((b) => /force/i.test(b))).toBe(true);
      expect(bodies.some((b) => /1 tool call/i.test(b))).toBe(true);
    });

    it("agentic review that reports before the budget posts no budget comment", async () => {
      enableAgenticFs(JSON.stringify({ enabled: true }));
      const mockExplore = vi.fn().mockResolvedValue({
        toolUses: [{ name: "report_findings", input: { findings: [FINDING] } }],
        metadata: { inputTokens: 10, outputTokens: 5, durationMs: 1 },
      });
      mockCreateLlmAdapter.mockReturnValue({ review: mockReview, respond: vi.fn(), explore: mockExplore });

      await runPipeline(baseConfig);

      const bodies = mockCreateComment.mock.calls.map((c) => (c[0] as { body: string }).body);
      expect(bodies.some((b) => /force/i.test(b))).toBe(false);
    });

    it("aborted agentic loop posts nothing (US-027 AC-3)", async () => {
      enableAgenticFs(JSON.stringify({ enabled: true }));
      const controller = new AbortController();
      controller.abort();
      const mockExplore = vi.fn();
      mockCreateLlmAdapter.mockReturnValue({ review: mockReview, respond: vi.fn(), explore: mockExplore });

      const result = await runPipeline(baseConfig, { signal: controller.signal });

      expect(result.status).toBe("completed");
      expect(result.findings ?? []).toEqual([]);
      expect(mockCreateReview).not.toHaveBeenCalled();
      expect(mockCreateComment).not.toHaveBeenCalled();
    });

    it("oversized diff is truncated to fit maxContextTokens and invites force (US-027 AC-1)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // Tiny budget via .reviewer.yml + huge diff
      mockExistsSync.mockImplementation((path: unknown) => {
        if (typeof path === "string" && path.endsWith(".reviewer-mcp.json")) return true;
        if (typeof path === "string" && path.endsWith(".reviewer.yml")) return true;
        return false;
      });
      mockReadFileSync.mockImplementation((path: string) => {
        if (path.endsWith(".reviewer-mcp.json")) return JSON.stringify({ enabled: true });
        if (path.endsWith(".reviewer.yml")) return "reviewer:\n  max_context_tokens: 50\n";
        return "";
      });
      mockGitDiff.mockResolvedValue(`diff --git a/x b/x\n${"+ padding line\n".repeat(500)}`);

      const mockExplore = vi.fn().mockResolvedValue({
        toolUses: [{ name: "report_findings", input: { findings: [] } }],
        metadata: { inputTokens: 10, outputTokens: 5, durationMs: 1 },
      });
      mockCreateLlmAdapter.mockReturnValue({ review: mockReview, respond: vi.fn(), explore: mockExplore });

      const result = await runPipeline(baseConfig);

      expect(result.status).toBe("completed");
      const sentUser = mockExplore.mock.calls[0][0].messages[0].content as string;
      expect(sentUser).toContain("[diff truncated]");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("truncat"));
      const bodies = mockCreateComment.mock.calls.map((c) => (c[0] as { body: string }).body);
      expect(bodies.some((b) => /force/i.test(b))).toBe(true);
      warn.mockRestore();
    });

    it("no file → v3 path, no agentic call", async () => {
      const mockExplore = vi.fn();
      mockCreateLlmAdapter.mockReturnValue({ review: mockReview, respond: vi.fn(), explore: mockExplore });

      const result = await runPipeline(baseConfig);

      expect(result.status).toBe("completed");
      expect(mockExplore).not.toHaveBeenCalled();
      expect(mockReview).toHaveBeenCalled();
      expect(result.mcpConfig).toBeUndefined();
    });

    it("invalid file → v3 path, completed, warning logged", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      enableAgenticFs("{ not json");
      const mockExplore = vi.fn();
      mockCreateLlmAdapter.mockReturnValue({ review: mockReview, respond: vi.fn(), explore: mockExplore });

      const result = await runPipeline(baseConfig);

      expect(result.status).toBe("completed");
      expect(mockExplore).not.toHaveBeenCalled();
      expect(mockReview).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(".reviewer-mcp.json"));
      warn.mockRestore();
    });
  });

  describe("repository knowledge (KIT-039)", () => {
    const ENTRY = { text: "we always use zod", source: "command", author: "alice", score: 0.9 };

    it("knowledge entries reach the monolithic prompt", async () => {
      mockCreateKnowledgeClient.mockReturnValue({
        search: vi.fn().mockResolvedValue([ENTRY]),
        insert: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      });

      await runPipeline(baseConfig);

      const [context] = mockReview.mock.calls[0];
      expect(context.prompt.user).toContain("Repository knowledge:");
      expect(context.prompt.user).toContain("we always use zod");
      expect(context.prompt.system).toContain("REPOSITORY KNOWLEDGE:");
    });

    it("unset secrets → no knowledge block, review runs normally", async () => {
      mockCreateKnowledgeClient.mockReturnValue(undefined);

      const result = await runPipeline(baseConfig);

      expect(result.status).toBe("completed");
      const [context] = mockReview.mock.calls[0];
      expect(context.prompt.user).not.toContain("Repository knowledge:");
    });

    it("knowledge search failure → warning, review completes without a block", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockCreateKnowledgeClient.mockReturnValue({
        search: vi.fn().mockRejectedValue(new Error("atlas down")),
        insert: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      });

      const result = await runPipeline(baseConfig);

      expect(result.status).toBe("completed");
      const [context] = mockReview.mock.calls[0];
      expect(context.prompt.user).not.toContain("Repository knowledge:");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("knowledge"));
      warn.mockRestore();
    });
  });
});

