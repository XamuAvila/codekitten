import { describe, it, expect, vi, beforeEach } from "vitest";
import { simpleGit } from "simple-git";
import { cloneRepo } from "../../src/git/clone.js";

vi.mock("simple-git");

describe("cloneRepo", () => {
  const mockGit = {
    clone: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(simpleGit).mockReturnValue(mockGit as never);
  });

  it("calls git clone with --depth=1 and correct branch", async () => {
    mockGit.clone.mockResolvedValueOnce(undefined);

    const result = await cloneRepo("octocat/Hello-World", "main", "/tmp/test-clone");

    expect(result.dir).toBe("/tmp/test-clone");
    // dir doesn't exist (mocked clone), sizeBytes is 0
    expect(typeof result.sizeBytes).toBe("number");
    expect(mockGit.clone).toHaveBeenCalledWith(
      "https://github.com/octocat/Hello-World.git",
      "/tmp/test-clone",
      { "--depth": "1", "--branch": "main" },
    );
    expect(mockGit.clone).toHaveBeenCalledTimes(1);
  });

  it("returns AppError NOT_FOUND when clone fails", async () => {
    mockGit.clone.mockRejectedValueOnce(new Error("Repository not found"));

    await expect(
      cloneRepo("nonexistent/repo", "main", "/tmp/fail"),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Repository not found or inaccessible",
    });
  });
});
