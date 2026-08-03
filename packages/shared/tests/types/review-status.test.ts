import { describe, expect, it } from "vitest";
import { ReviewJobStatusSchema } from "../../src/types/review-status.js";

describe("ReviewJobStatusSchema", () => {
  it("accepts cancelled as a valid status", () => {
    const result = ReviewJobStatusSchema.safeParse({
      jobId: "review-x-1",
      status: "cancelled",
      podName: "review-x-1",
      createdAt: "2026-08-03T00:00:00Z",
      followUpCount: 0,
    });

    expect(result.success).toBe(true);
  });

  it("rejects an unknown status", () => {
    const result = ReviewJobStatusSchema.safeParse({
      jobId: "review-x-1",
      status: "cancelling",
      podName: "review-x-1",
      createdAt: "2026-08-03T00:00:00Z",
      followUpCount: 0,
    });

    expect(result.success).toBe(false);
  });
});
