import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { createReviewRouter } from "../../src/routes/review.js";
import { errorHandler } from "../../src/middleware/error-handler.js";
import type { K8sClient } from "../../src/k8s/client.js";
import type { PodConfig } from "../../src/k8s/manifest.js";

function createMockK8sClient(): K8sClient {
  return {
    createPod: vi.fn().mockResolvedValue({}),
    deletePod: vi.fn().mockResolvedValue(undefined),
    getPod: vi.fn().mockResolvedValue({}),
  } as unknown as K8sClient;
}

function createMockRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve("OK");
    }),
    _store: store,
  } as unknown as import("ioredis").Redis;
}

const podConfig: PodConfig = {
  namespace: "kitten",
  image: "kitten-reviewer:latest",
  idleTimeoutMs: 600000,
  redisUrl: "redis://localhost:6379",
};

function buildApp(k8sClient: K8sClient, redis: ReturnType<typeof createMockRedis>) {
  const app = express();
  app.use(express.json());
  app.use(createReviewRouter({ k8sClient, redis, podConfig }));
  app.use(errorHandler);
  return app;
}

describe("POST /review", () => {
  let mockK8s: K8sClient;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockK8s = createMockK8sClient();
    mockRedis = createMockRedis();
  });

  it("creates K8s Pod and returns 202", async () => {
    const res = await request(buildApp(mockK8s, mockRedis))
      .post("/review")
      .send({ repo: "octocat/Hello-World", prNumber: 1, headRef: "main", baseRef: "master", sender: "test" });

    expect(res.status).toBe(202);
    expect(res.body.jobId).toBe("review-octocat-hello-world-1");
    expect(res.body.status).toBe("queued");
    expect(mockK8s.createPod).toHaveBeenCalledOnce();
  });

  it("stores initial status in Redis", async () => {
    await request(buildApp(mockK8s, mockRedis))
      .post("/review")
      .send({ repo: "octocat/Hello-World", prNumber: 1, headRef: "main", baseRef: "master", sender: "test" });

    expect(mockRedis.set).toHaveBeenCalledOnce();
    const [key, value] = (mockRedis.set as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(key).toBe("review:review-octocat-hello-world-1:status");
    const status = JSON.parse(value);
    expect(status.status).toBe("queued");
    expect(status.followUpCount).toBe(0);
  });

  it("returns 503 when K8s API unavailable", async () => {
    (mockK8s.createPod as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("K8s down"));

    const res = await request(buildApp(mockK8s, mockRedis))
      .post("/review")
      .send({ repo: "org/repo", prNumber: 1, headRef: "main", baseRef: "master", sender: "test" });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("returns 400 for invalid payload", async () => {
    const res = await request(buildApp(mockK8s, mockRedis))
      .post("/review")
      .send({ prNumber: 1 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });

  it("returns 400 for negative prNumber", async () => {
    const res = await request(buildApp(mockK8s, mockRedis))
      .post("/review")
      .send({ repo: "org/repo", prNumber: -1, headRef: "main", baseRef: "master", sender: "test" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });
});
