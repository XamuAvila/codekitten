import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPullsGet = vi.fn();

vi.mock("@octokit/rest", () => ({
  Octokit: class MockOctokit {
    pulls = { get: mockPullsGet };
  },
}));

import { fetchPrMetadata } from "../../src/github/pr.js";

describe("fetchPrMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns title, author, state for an open PR", async () => {
    mockPullsGet.mockResolvedValueOnce({
      data: {
        title: "Add feature X",
        user: { login: "octocat" },
        state: "open",
        merged: false,
      },
    });

    const result = await fetchPrMetadata("test-token", "owner/repo", 1);

    expect(result).toEqual({
      title: "Add feature X",
      author: "octocat",
      state: "open",
    });
  });

  it("returns state 'merged' when PR is merged", async () => {
    mockPullsGet.mockResolvedValueOnce({
      data: {
        title: "Merged PR",
        user: { login: "dev" },
        state: "closed",
        merged: true,
      },
    });

    const result = await fetchPrMetadata("test-token", "owner/repo", 2);

    expect(result.state).toBe("merged");
  });

  it("returns state 'closed' when PR is closed but not merged", async () => {
    mockPullsGet.mockResolvedValueOnce({
      data: {
        title: "Closed PR",
        user: { login: "dev" },
        state: "closed",
        merged: false,
      },
    });

    const result = await fetchPrMetadata("test-token", "owner/repo", 3);

    expect(result.state).toBe("closed");
  });

  it("returns 'unknown' as author when user is null", async () => {
    mockPullsGet.mockResolvedValueOnce({
      data: {
        title: "Ghost PR",
        user: null,
        state: "open",
        merged: false,
      },
    });

    const result = await fetchPrMetadata("test-token", "owner/repo", 4);

    expect(result.author).toBe("unknown");
  });

  it("calls Octokit pulls.get with correct params", async () => {
    mockPullsGet.mockResolvedValueOnce({
      data: {
        title: "Test",
        user: { login: "dev" },
        state: "open",
        merged: false,
      },
    });

    await fetchPrMetadata("test-token", "owner/repo", 42);

    expect(mockPullsGet).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      pull_number: 42,
    });
  });

  it("throws NOT_FOUND AppError for 404", async () => {
    mockPullsGet.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );

    await expect(
      fetchPrMetadata("test-token", "owner/repo", 999),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "PR #999 not found in owner/repo",
    });
  });

  it("throws GITHUB_API_ERROR for other API errors", async () => {
    mockPullsGet.mockRejectedValueOnce(
      Object.assign(new Error("Server Error"), { status: 500 }),
    );

    await expect(
      fetchPrMetadata("test-token", "owner/repo", 1),
    ).rejects.toMatchObject({
      code: "GITHUB_API_ERROR",
    });
  });

  it("throws VALIDATION for invalid repo format", async () => {
    await expect(
      fetchPrMetadata("test-token", "invalid-repo", 1),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: "Invalid repo format — expected 'owner/repo'",
    });
  });
});
