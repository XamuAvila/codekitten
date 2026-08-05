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

  it("constructs auth URL with x-access-token", async () => {
    mockGit.clone.mockResolvedValueOnce(undefined);

    await cloneRepo("owner/repo", "main", "/tmp/test-clone", "test-token-123");

    expect(mockGit.clone).toHaveBeenCalledWith(
      "https://x-access-token:test-token-123@github.com/owner/repo.git",
      "/tmp/test-clone",
      ["--branch", "main"],
    );
  });

  it("checks out the requested head branch (KIT-041) with no depth restriction", async () => {
    mockGit.clone.mockResolvedValueOnce(undefined);

    await cloneRepo("owner/repo", "feat/x", "/tmp/test-clone", "tok");

    const [, , options] = mockGit.clone.mock.calls[0];
    expect(options).toEqual(["--branch", "feat/x"]);
    expect(options.join(" ")).not.toContain("--depth");
  });

  it("wraps git errors in AppError NOT_FOUND", async () => {
    mockGit.clone.mockRejectedValueOnce(new Error("Repository not found"));

    await expect(
      cloneRepo("nonexistent/repo", "main", "/tmp/fail", "tok"),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Repository not found or inaccessible",
    });
  });

  it("does not leak token in error details", async () => {
    const secretToken = "ghp_superSecretToken12345";
    mockGit.clone.mockRejectedValueOnce(
      new Error(`fatal: could not read Username for 'https://x-access-token:${secretToken}@github.com': No such device`),
    );

    try {
      await cloneRepo("owner/repo", "main", "/tmp/fail", secretToken);
      expect.unreachable("should have thrown");
    } catch (error: unknown) {
      const stringified = JSON.stringify(error);
      expect(stringified).not.toContain(secretToken);
    }
  });
});
