import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { createStatusRouter } from "../../src/routes/status.js";
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
    _store: data,
  } as unknown as import("ioredis").Redis;
}

function buildApp(redis: import("ioredis").Redis) {
  const app = express();
  app.use(express.json());
  app.use(createStatusRouter(redis));
  app.use(errorHandler);
  return app;
}

describe("GET /status/:jobId", () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
  });

  it("returns job status from Redis", async () => {
    const status: ReviewJobStatus = {
      jobId: "review-org-repo-1",
      status: "queued",
      podName: "review-org-repo-1",
      createdAt: "2026-08-03T00:00:00.000Z",
      followUpCount: 0,
    };
    await mockRedis.set(
      "review:review-org-repo-1:status",
      JSON.stringify(status),
    );

    const res = await request(buildApp(mockRedis)).get(
      "/status/review-org-repo-1",
    );

    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe("review-org-repo-1");
    expect(res.body.status).toBe("queued");
    expect(res.body.podName).toBe("review-org-repo-1");
    expect(res.body.followUpCount).toBe(0);
  });

  it("returns 404 for unknown job", async () => {
    const res = await request(buildApp(mockRedis)).get(
      "/status/review-unknown-999",
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });
});
