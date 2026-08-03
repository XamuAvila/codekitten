import { describe, it, expect, vi, beforeEach } from "vitest";

// Track call order across mocks
const callOrder: string[] = [];

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

vi.mock("@octokit/rest", () => ({
  Octokit: class MockOctokit {
    pulls = { listFiles: mockListFiles };
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

describe("runPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;

    // Defaults: fs.existsSync returns false
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
    mockStatSync.mockReturnValue({ size: 0 });

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

  it("calls steps in order: clone → diff → fetchPrFiles → analyze", async () => {
    await runPipeline(baseConfig);

    // clone happens first, then fetch (for diff), then listFiles (PR files)
    expect(callOrder.indexOf("clone")).toBeLessThan(callOrder.indexOf("fetch"));
    expect(callOrder.indexOf("fetch")).toBeLessThan(callOrder.indexOf("listFiles"));
  });

  it("returns completed PipelineResult on success", async () => {
    const result = await runPipeline(baseConfig);

    expect(result.status).toBe("completed");
    expect(result.dryRun).toBe(true);
    expect(result.metadata.repo).toBe("octocat/Hello-World");
    expect(result.metadata.prNumber).toBe(42);
    expect(typeof result.metadata.durationMs).toBe("number");
    expect(result.metadata.durationMs).toBeGreaterThanOrEqual(0);
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
    // existsSync: true for clone dir cleanup check
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
    // Make clone fail
    mockGitClone.mockRejectedValue(new Error("clone failed"));

    // existsSync: true for cleanup
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

    // Pipeline should complete successfully with defaults
    expect(result.status).toBe("completed");
  });
});
