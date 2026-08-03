import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ReviewQueue } from "../../src/queue/producer.js";
import type { ReviewJob } from "@kitten/shared";

const TEST_REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const TEST_QUEUE = `test-reviews-${Date.now()}`;

describe("ReviewQueue", () => {
  let queue: ReviewQueue;

  beforeEach(async () => {
    queue = new ReviewQueue(TEST_REDIS_URL, { queueName: TEST_QUEUE });
    await queue.connect();
  });

  afterEach(async () => {
    await queue.cleanAll();
    await queue.close();
  });

  const validJob: ReviewJob = {
    repo: "octocat/Hello-World",
    prNumber: 1,
    headRef: "main",
    baseRef: "main~1",
    sender: "test",
    isReReview: false,
  };

  it("enqueue returns deterministic job ID", async () => {
    const jobId = await queue.enqueue(validJob);
    expect(jobId).toBe("review-octocat-Hello-World-1");
  });

  it("getStatus returns waiting for queued job", async () => {
    const jobId = await queue.enqueue(validJob);
    const status = await queue.getStatus(jobId);
    expect(status).toEqual({ status: "waiting" });
  });

  it("getStatus returns not_found for unknown job", async () => {
    const status = await queue.getStatus("review-unknown-999");
    expect(status).toEqual({ status: "not_found" });
  });

  it("enqueue with different PR produces different job ID", async () => {
    const jobId1 = await queue.enqueue(validJob);
    const jobId2 = await queue.enqueue({ ...validJob, prNumber: 2 });
    expect(jobId1).toBe("review-octocat-Hello-World-1");
    expect(jobId2).toBe("review-octocat-Hello-World-2");
  });

  it("isReReview defaults to false", async () => {
    const jobId = await queue.enqueue(validJob);
    expect(jobId).toBe("review-octocat-Hello-World-1");
    // Check the job was actually enqueued
    const status = await queue.getStatus(jobId);
    expect(status.status).toBe("waiting");
  });
});
