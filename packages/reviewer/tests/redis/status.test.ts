import { describe, it, expect, vi, beforeEach } from "vitest";
import { reportStatus, incrementFollowUpCount, getStatus } from "../../src/redis/status.js";

function createMockRedis(store?: Map<string, string>) {
  const data = store ?? new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(data.get(key) ?? null)),
    set: vi.fn((key: string, value: string) => {
      data.set(key, value);
      return Promise.resolve("OK");
    }),
  } as unknown as import("ioredis").Redis;
}

describe("reportStatus", () => {
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    redis = createMockRedis();
  });

  it("writes status to Redis with correct key", async () => {
    await reportStatus(redis, "job-1", "running");

    expect(redis.set).toHaveBeenCalledOnce();
    const [key, value] = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(key).toBe("review:job-1:status");
    const parsed = JSON.parse(value);
    expect(parsed.status).toBe("running");
  });

  it("sets correct status value for reviewing", async () => {
    await reportStatus(redis, "job-2", "reviewing");

    const [, value] = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(value).status).toBe("reviewing");
  });

  it("sets completedAt when status is completed", async () => {
    await reportStatus(redis, "job-1", "completed");

    const [, value] = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = JSON.parse(value);
    expect(parsed.status).toBe("completed");
    expect(parsed.completedAt).toBeDefined();
  });

  it("sets completedAt when status is failed", async () => {
    await reportStatus(redis, "job-1", "failed");

    const [, value] = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = JSON.parse(value);
    expect(parsed.status).toBe("failed");
    expect(parsed.completedAt).toBeDefined();
  });

  it("sets completedAt when status is cancelled", async () => {
    await reportStatus(redis, "job-1", "cancelled");

    const [, value] = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = JSON.parse(value);
    expect(parsed.status).toBe("cancelled");
    expect(parsed.completedAt).toBeDefined();
  });

  it("merges with existing status data", async () => {
    const store = new Map<string, string>();
    store.set("review:job-1:status", JSON.stringify({
      jobId: "job-1", status: "queued", podName: "pod-1",
      createdAt: "2026-08-03T00:00:00Z", followUpCount: 0,
    }));
    redis = createMockRedis(store);

    await reportStatus(redis, "job-1", "running");

    const [, value] = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = JSON.parse(value);
    expect(parsed.status).toBe("running");
    expect(parsed.podName).toBe("pod-1");
    expect(parsed.followUpCount).toBe(0);
  });
});

describe("incrementFollowUpCount", () => {
  it("increments followUpCount from 0 to 1", async () => {
    const store = new Map<string, string>();
    store.set("review:job-1:status", JSON.stringify({
      jobId: "job-1", status: "reviewing", podName: "pod-1",
      createdAt: "2026-08-03T00:00:00Z", followUpCount: 0,
    }));
    const redis = createMockRedis(store);

    const result = await incrementFollowUpCount(redis, "job-1");

    expect(result).toBe(1);
  });

  it("increments followUpCount from 2 to 3", async () => {
    const store = new Map<string, string>();
    store.set("review:job-1:status", JSON.stringify({
      jobId: "job-1", status: "reviewing", podName: "pod-1",
      createdAt: "2026-08-03T00:00:00Z", followUpCount: 2,
    }));
    const redis = createMockRedis(store);

    const result = await incrementFollowUpCount(redis, "job-1");

    expect(result).toBe(3);
  });

  it("returns 0 for missing key", async () => {
    const redis = createMockRedis();
    const result = await incrementFollowUpCount(redis, "nonexistent");
    expect(result).toBe(0);
  });
});

describe("getStatus", () => {
  it("returns null for missing key", async () => {
    const redis = createMockRedis();
    const result = await getStatus(redis, "nonexistent");
    expect(result).toBeNull();
  });

  it("returns parsed ReviewJobStatus for existing key", async () => {
    const store = new Map<string, string>();
    store.set("review:job-1:status", JSON.stringify({
      jobId: "job-1", status: "reviewing", podName: "pod-1",
      createdAt: "2026-08-03T00:00:00Z", followUpCount: 2,
    }));
    const redis = createMockRedis(store);

    const result = await getStatus(redis, "job-1");

    expect(result).not.toBeNull();
    expect(result!.status).toBe("reviewing");
    expect(result!.jobId).toBe("job-1");
    expect(result!.followUpCount).toBe(2);
  });
});
