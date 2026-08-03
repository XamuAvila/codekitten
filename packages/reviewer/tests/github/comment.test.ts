import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReviewCommentData } from "../../src/types.js";

const mockCreateComment = vi.fn();

vi.mock("@octokit/rest", () => ({
  Octokit: class MockOctokit {
    issues = { createComment: mockCreateComment };
  },
}));

import { postReviewComment, postFollowUpAck } from "../../src/github/comment.js";

const baseSummary: ReviewCommentData = {
  repo: "owner/repo",
  prNumber: 42,
  fileCount: { total: 10, analyzed: 8, skipped: 2 },
  tokenEstimate: 15000,
  model: "gpt-4o",
  diff: { insertions: 50, deletions: 20 },
};

describe("postReviewComment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls Octokit issues.createComment with correct params", async () => {
    mockCreateComment.mockResolvedValueOnce({ data: { id: 1, html_url: "https://url" } });

    await postReviewComment("test-token", "owner/repo", 42, baseSummary);

    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      issue_number: 42,
      body: expect.any(String),
    });
  });

  it("includes review summary in body", async () => {
    mockCreateComment.mockResolvedValueOnce({ data: { id: 1, html_url: "https://url" } });

    await postReviewComment("test-token", "owner/repo", 42, baseSummary);

    const body = mockCreateComment.mock.calls[0]![0].body as string;
    expect(body).toContain("owner/repo");
    expect(body).toContain("#42");
    expect(body).toContain("15.0k tokens");
    expect(body).toContain("gpt-4o");
    expect(body).toContain("8 (2 skipped)");
    expect(body).toContain("+50 -20");
  });

  it("includes [KITTEN-TEST] prefix", async () => {
    mockCreateComment.mockResolvedValueOnce({ data: { id: 1, html_url: "https://url" } });

    await postReviewComment("test-token", "owner/repo", 42, baseSummary);

    const body = mockCreateComment.mock.calls[0]![0].body as string;
    expect(body).toContain("[KITTEN-TEST]");
  });

  it("includes dry-run notice", async () => {
    mockCreateComment.mockResolvedValueOnce({ data: { id: 1, html_url: "https://url" } });

    await postReviewComment("test-token", "owner/repo", 42, baseSummary);

    const body = mockCreateComment.mock.calls[0]![0].body as string;
    expect(body).toContain("This is a dry-run review (v2)");
  });

  it("does NOT throw on API error (non-fatal)", async () => {
    mockCreateComment.mockRejectedValueOnce(
      Object.assign(new Error("Forbidden"), { status: 403 }),
    );

    // Should not throw — non-fatal
    await expect(
      postReviewComment("test-token", "owner/repo", 42, baseSummary),
    ).resolves.toBeUndefined();
  });

  it("logs error on API failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockCreateComment.mockRejectedValueOnce(
      Object.assign(new Error("Forbidden"), { status: 403 }),
    );

    await postReviewComment("test-token", "owner/repo", 42, baseSummary);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to post review comment"),
    );
    consoleSpy.mockRestore();
  });
});

describe("postFollowUpAck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts ack comment with message quoted", async () => {
    mockCreateComment.mockResolvedValueOnce({ data: { id: 2, html_url: "https://url" } });

    await postFollowUpAck("test-token", "owner/repo", 42, "explain X");

    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      issue_number: 42,
      body: expect.any(String),
    });

    const body = mockCreateComment.mock.calls[0]![0].body as string;
    expect(body).toContain('"explain X"');
    expect(body).toContain("[KITTEN-TEST]");
    expect(body).toContain("Follow-up processing with LLM available in v3.");
  });

  it("does NOT throw on API error (non-fatal)", async () => {
    mockCreateComment.mockRejectedValueOnce(
      Object.assign(new Error("Unprocessable"), { status: 422 }),
    );

    await expect(
      postFollowUpAck("test-token", "owner/repo", 42, "some message"),
    ).resolves.toBeUndefined();
  });

  it("logs error on API failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockCreateComment.mockRejectedValueOnce(
      Object.assign(new Error("Unprocessable"), { status: 422 }),
    );

    await postFollowUpAck("test-token", "owner/repo", 42, "some message");

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to post follow-up ack"),
    );
    consoleSpy.mockRestore();
  });
});
