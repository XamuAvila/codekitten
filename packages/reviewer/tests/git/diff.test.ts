import { describe, it, expect, vi, beforeEach } from "vitest";
import { simpleGit } from "simple-git";
import { generateDiff } from "../../src/git/diff.js";

vi.mock("simple-git");

describe("generateDiff", () => {
  const mockGit = {
    fetch: vi.fn(),
    diff: vi.fn(),
    diffSummary: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(simpleGit).mockReturnValue(mockGit as never);
  });

  it("calls git fetch for base ref", async () => {
    mockGit.fetch.mockResolvedValueOnce(undefined);
    mockGit.diff.mockResolvedValueOnce("diff content");
    mockGit.diffSummary.mockResolvedValueOnce({
      changed: 3,
      insertions: 31,
      deletions: 5,
    });

    await generateDiff("/tmp/repo", "main", "feat/x");

    expect(mockGit.fetch).toHaveBeenCalledWith(["origin", "main", "--depth=1"]);
  });

  it("calls git diff with three-dot syntax", async () => {
    mockGit.fetch.mockResolvedValueOnce(undefined);
    mockGit.diff.mockResolvedValueOnce("diff output");
    mockGit.diffSummary.mockResolvedValueOnce({
      changed: 1,
      insertions: 10,
      deletions: 2,
    });

    await generateDiff("/tmp/repo", "main", "feat/x");

    expect(mockGit.diff).toHaveBeenCalledWith(["origin/main...feat/x"]);
    expect(mockGit.diffSummary).toHaveBeenCalledWith(["origin/main...feat/x"]);
  });

  it("parses stat output into DiffResult", async () => {
    mockGit.fetch.mockResolvedValueOnce(undefined);
    mockGit.diff.mockResolvedValueOnce("--- a/file.ts\n+++ b/file.ts");
    mockGit.diffSummary.mockResolvedValueOnce({
      changed: 3,
      insertions: 31,
      deletions: 0,
    });

    const result = await generateDiff("/tmp/repo", "main", "feat/x");

    expect(result).toEqual({
      raw: "--- a/file.ts\n+++ b/file.ts",
      filesChanged: 3,
      insertions: 31,
      deletions: 0,
    });
  });

  it("wraps errors in AppError", async () => {
    mockGit.fetch.mockRejectedValueOnce(new Error("fetch failed"));

    await expect(
      generateDiff("/tmp/repo", "main", "feat/x"),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Failed to generate diff",
    });
  });
});
