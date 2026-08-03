import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { createReviewRouter } from "../../src/routes/review.js";
import { createStatusRouter } from "../../src/routes/status.js";
import { createHealthRouter } from "../../src/routes/health.js";
import { errorHandler } from "../../src/middleware/error-handler.js";
import { ReviewQueue } from "../../src/queue/producer.js";

const TEST_REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const TEST_QUEUE = `test-reviews-${Date.now()}`;

function buildApp(queue: ReviewQueue) {
  const app = express();
  app.use(express.json());
  // Mock redis for health route (not used in these tests but needed for wiring)
  const redis = { ping: async () => "PONG" } as unknown as import("ioredis").Redis;
  app.use(createHealthRouter(redis));
  app.use(createReviewRouter(queue));
  app.use(createStatusRouter(queue));
  app.use(errorHandler);
  return app;
}

describe("POST /review", () => {
  let queue: ReviewQueue;

  beforeEach(async () => {
    queue = new ReviewQueue(TEST_REDIS_URL, { queueName: TEST_QUEUE });
    await queue.connect();
  });

  afterEach(async () => {
    await queue.cleanAll();
    await queue.close();
  });

  it("returns 202 with jobId for valid payload", async () => {
    const res = await request(buildApp(queue))
      .post("/review")
      .send({ repo: "octocat/Hello-World", prNumber: 1, headRef: "main", baseRef: "main~1", sender: "test" });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBe("review-octocat-Hello-World-1");
    expect(res.body.status).toBe("queued");
  });

  it("returns 400 VALIDATION for missing repo", async () => {
    const res = await request(buildApp(queue))
      .post("/review")
      .send({ prNumber: 1, headRef: "main", baseRef: "main~1", sender: "test" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });

  it("returns 400 VALIDATION for negative prNumber", async () => {
    const res = await request(buildApp(queue))
      .post("/review")
      .send({ repo: "org/repo", prNumber: -1, headRef: "main", baseRef: "main~1", sender: "test" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });

  it("defaults isReReview to false when omitted", async () => {
    const res = await request(buildApp(queue))
      .post("/review")
      .send({ repo: "org/repo", prNumber: 5, headRef: "feat/x", baseRef: "main", sender: "dev" });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBe("review-org-repo-5");
  });
});

describe("GET /status/:jobId", () => {
  let queue: ReviewQueue;

  beforeEach(async () => {
    queue = new ReviewQueue(TEST_REDIS_URL, { queueName: TEST_QUEUE });
    await queue.connect();
  });

  afterEach(async () => {
    await queue.cleanAll();
    await queue.close();
  });

  it("returns job state for queued job", async () => {
    const jobId = await queue.enqueue({
      repo: "org/repo", prNumber: 1, headRef: "main", baseRef: "main~1", sender: "test", isReReview: false,
    });
    const res = await request(buildApp(queue)).get(`/status/${jobId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBeDefined();
  });

  it("returns 404 for unknown job", async () => {
    const res = await request(buildApp(queue)).get("/status/review-unknown-999");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });
});
