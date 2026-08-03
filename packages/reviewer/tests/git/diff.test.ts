import { describe, it, expect, vi, beforeEach } from "vitest";
import { simpleGit } from "simple-git";
import { generateDiff } from "../../src/git/diff.js";

vi.mock("simple-git");

describe("generateDiff", () => {
  const mockGit = {
    diff: vi.fn(),
    diffSummary: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(simpleGit).mockReturnValue(mockGit as never);
  });

  it("calls git diff with three-dot origin refs", async () => {
    mockGit.diff.mockResolvedValueOnce("diff output");
    mockGit.diffSummary.mockResolvedValueOnce({
      changed: 1,
      insertions: 10,
      deletions: 2,
    });

    await generateDiff("/tmp/repo", "main", "feat/x");

    expect(mockGit.diff).toHaveBeenCalledWith(["origin/main...origin/feat/x"]);
    expect(mockGit.diffSummary).toHaveBeenCalledWith(["origin/main...origin/feat/x"]);
  });

  it("parses stat output into DiffResult", async () => {
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
    mockGit.diff.mockRejectedValueOnce(new Error("diff failed"));

    await expect(
      generateDiff("/tmp/repo", "main", "feat/x"),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Failed to generate diff",
    });
  });
});
