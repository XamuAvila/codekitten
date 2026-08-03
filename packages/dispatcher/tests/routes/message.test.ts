import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { createMessageRouter } from "../../src/routes/message.js";
import { errorHandler } from "../../src/middleware/error-handler.js";
import type { ReviewJobStatus } from "@kitten/shared";

function createMockRedis(store?: Map<string, string>) {
  const data = store ?? new Map<string, string>();
  return {
    get: vi.fn((key: string) => {
      return Promise.resolve(data.get(key) ?? null);
    }),
    set: vi.fn((key: string, value: string) => {
      data.set(key, value);
      return Promise.resolve("OK");
    }),
    publish: vi.fn().mockResolvedValue(1),
    _store: data,
  } as unknown as import("ioredis").Redis & { _store: Map<string, string> };
}

function buildApp(redis: import("ioredis").Redis) {
  const app = express();
  app.use(express.json());
  app.use(createMessageRouter(redis));
  app.use(errorHandler);
  return app;
}

function seedActiveJob(
  redis: ReturnType<typeof createMockRedis>,
  jobId: string,
): void {
  const status: ReviewJobStatus = {
    jobId,
    status: "running",
    podName: jobId,
    createdAt: "2026-08-03T00:00:00.000Z",
    followUpCount: 0,
  };
  redis._store.set(`review:${jobId}:status`, JSON.stringify(status));
}

describe("POST /review/:jobId/message", () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
  });

  it("publishes to Redis channel and returns 200", async () => {
    seedActiveJob(mockRedis, "review-org-repo-1");

    const res = await request(buildApp(mockRedis))
      .post("/review/review-org-repo-1/message")
      .send({ message: "Please also check tests", sender: "dev" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "sent" });

    expect(mockRedis.publish).toHaveBeenCalledOnce();
    const [channel, payload] = (mockRedis.publish as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [string, string];
    expect(channel).toBe("review:review-org-repo-1:messages");

    const parsed = JSON.parse(payload);
    expect(parsed.type).toBe("follow_up");
    expect(parsed.payload.message).toBe("Please also check tests");
    expect(parsed.payload.sender).toBe("dev");
    expect(parsed.timestamp).toBeDefined();
  });

  it("returns 200 with sent status", async () => {
    seedActiveJob(mockRedis, "review-org-repo-2");

    const res = await request(buildApp(mockRedis))
      .post("/review/review-org-repo-2/message")
      .send({ message: "hi", sender: "user" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");
  });

  it("returns 404 for unknown jobId", async () => {
    const res = await request(buildApp(mockRedis))
      .post("/review/nonexistent-job/message")
      .send({ message: "hi", sender: "user" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("returns 400 for invalid body", async () => {
    seedActiveJob(mockRedis, "review-org-repo-3");

    const res = await request(buildApp(mockRedis))
      .post("/review/review-org-repo-3/message")
      .send({ sender: "user" }); // missing "message" field

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });

  it("returns 404 for completed job", async () => {
    const completedStatus: ReviewJobStatus = {
      jobId: "review-org-repo-4",
      status: "completed",
      podName: "review-org-repo-4",
      createdAt: "2026-08-03T00:00:00.000Z",
      completedAt: "2026-08-03T01:00:00.000Z",
      followUpCount: 0,
    };
    mockRedis._store.set(
      "review:review-org-repo-4:status",
      JSON.stringify(completedStatus),
    );

    const res = await request(buildApp(mockRedis))
      .post("/review/review-org-repo-4/message")
      .send({ message: "hi", sender: "user" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("does not increment followUpCount — the Pod owns that counter", async () => {
    seedActiveJob(mockRedis, "review-org-repo-5");

    await request(buildApp(mockRedis))
      .post("/review/review-org-repo-5/message")
      .send({ message: "first", sender: "dev" });

    // The dispatcher publishes fire-and-forget; only the Pod that actually
    // receives the message increments the counter. Double-counting otherwise.
    const rawAfter = mockRedis._store.get("review:review-org-repo-5:status");
    expect(rawAfter).toBeDefined();
    const statusAfter = JSON.parse(rawAfter!);
    expect(statusAfter.followUpCount).toBe(0);
  });
});
