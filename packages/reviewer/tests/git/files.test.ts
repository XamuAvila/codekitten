import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchPrFiles } from "../../src/git/files.js";

const listFiles = vi.fn();

vi.mock("@octokit/rest", () => ({
  Octokit: class MockOctokit {
    pulls = { listFiles };
  },
}));

const mockApiResponse = [
  {
    filename: "src/app.ts",
    status: "modified",
    patch: "@@ -1,3 +1,5 @@",
    additions: 5,
    deletions: 2,
    changes: 7,
    blob_url: "https://github.com/owner/repo/blob/abc/src/app.ts",
    raw_url: "https://github.com/owner/repo/raw/abc/src/app.ts",
  },
  {
    filename: "README.md",
    status: "added",
    patch: "@@ -0,0 +1 @@",
    additions: 1,
    deletions: 0,
    changes: 1,
    blob_url: "https://github.com/owner/repo/blob/abc/README.md",
    raw_url: "https://github.com/owner/repo/raw/abc/README.md",
  },
  {
    filename: "docs/guide.md",
    status: "removed",
    patch: undefined,
    additions: 0,
    deletions: 10,
    changes: 10,
    blob_url: "https://github.com/owner/repo/blob/abc/docs/guide.md",
    raw_url: "https://github.com/owner/repo/raw/abc/docs/guide.md",
  },
];

describe("fetchPrFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls Octokit pulls.listFiles with correct params", async () => {
    listFiles.mockResolvedValueOnce({ data: mockApiResponse });

    await fetchPrFiles("owner/repo", 42, "test-token", []);

    expect(listFiles).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      pull_number: 42,
      per_page: 100,
    });
  });

  it("maps response to PullRequestFile[]", async () => {
    listFiles.mockResolvedValueOnce({ data: mockApiResponse });

    const files = await fetchPrFiles("owner/repo", 1, "tok", []);

    expect(files).toHaveLength(3);
    expect(files[0]).toEqual({
      filename: "src/app.ts",
      status: "modified",
      patch: "@@ -1,3 +1,5 @@",
      additions: 5,
      deletions: 2,
      changes: 7,
      blobUrl: "https://github.com/owner/repo/blob/abc/src/app.ts",
      rawUrl: "https://github.com/owner/repo/raw/abc/src/app.ts",
    });
    // Verify snake_case -> camelCase mapping
    expect(files[1]!.blobUrl).toBe("https://github.com/owner/repo/blob/abc/README.md");
    expect(files[1]!.rawUrl).toBe("https://github.com/owner/repo/raw/abc/README.md");
  });

  it("filters files by skip patterns", async () => {
    listFiles.mockResolvedValueOnce({ data: mockApiResponse });

    const files = await fetchPrFiles("owner/repo", 1, "tok", ["**/*.md"]);

    expect(files).toHaveLength(1);
    expect(files[0]!.filename).toBe("src/app.ts");
  });

  it("returns all files when no skip patterns", async () => {
    listFiles.mockResolvedValueOnce({ data: mockApiResponse });

    const files = await fetchPrFiles("owner/repo", 1, "tok", []);

    expect(files).toHaveLength(3);
  });

  it("wraps auth errors in AppError AUTH_FAILED", async () => {
    listFiles.mockRejectedValueOnce(
      Object.assign(new Error("Bad credentials"), { status: 401 }),
    );

    await expect(
      fetchPrFiles("owner/repo", 1, "bad-token", []),
    ).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: "GitHub authentication failed — token may be invalid or expired",
    });
  });
});
