import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock ioredis ---
const mockHset = vi.fn().mockResolvedValue(1);
const mockHgetall = vi.fn().mockResolvedValue({});
const mockHincrby = vi.fn().mockResolvedValue(1);

vi.mock("ioredis", () => ({
  Redis: class MockRedis {
    hset = mockHset;
    hgetall = mockHgetall;
    hincrby = mockHincrby;
  },
}));

import { reportStatus, incrementFollowUpCount, getStatus } from "../../src/redis/status.js";

describe("reportStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes status to Redis hash with correct key", async () => {
    const redis = { hset: mockHset, hgetall: mockHgetall, hincrby: mockHincrby } as any;

    await reportStatus(redis, "job-1", "running");

    expect(mockHset).toHaveBeenCalledWith(
      "review:job-1:status",
      "status",
      "running",
    );
  });

  it("sets correct status value for reviewing", async () => {
    const redis = { hset: mockHset, hgetall: mockHgetall, hincrby: mockHincrby } as any;

    await reportStatus(redis, "job-2", "reviewing");

    expect(mockHset).toHaveBeenCalledWith(
      "review:job-2:status",
      "status",
      "reviewing",
    );
  });

  it("sets completedAt when status is completed", async () => {
    const redis = { hset: mockHset, hgetall: mockHgetall, hincrby: mockHincrby } as any;

    await reportStatus(redis, "job-1", "completed");

    // Should have two hset calls: one for status, one for completedAt
    expect(mockHset).toHaveBeenCalledWith(
      "review:job-1:status",
      "status",
      "completed",
    );
    expect(mockHset).toHaveBeenCalledWith(
      "review:job-1:status",
      "completedAt",
      expect.any(String),
    );
  });

  it("sets completedAt when status is failed", async () => {
    const redis = { hset: mockHset, hgetall: mockHgetall, hincrby: mockHincrby } as any;

    await reportStatus(redis, "job-1", "failed");

    expect(mockHset).toHaveBeenCalledWith(
      "review:job-1:status",
      "status",
      "failed",
    );
    expect(mockHset).toHaveBeenCalledWith(
      "review:job-1:status",
      "completedAt",
      expect.any(String),
    );
  });
});

describe("incrementFollowUpCount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("increments followUpCount from 0 to 1", async () => {
    mockHincrby.mockResolvedValue(1);
    const redis = { hset: mockHset, hgetall: mockHgetall, hincrby: mockHincrby } as any;

    await incrementFollowUpCount(redis, "job-1");

    expect(mockHincrby).toHaveBeenCalledWith(
      "review:job-1:status",
      "followUpCount",
      1,
    );
  });

  it("increments followUpCount from 2 to 3", async () => {
    mockHincrby.mockResolvedValue(3);
    const redis = { hset: mockHset, hgetall: mockHgetall, hincrby: mockHincrby } as any;

    const result = await incrementFollowUpCount(redis, "job-1");

    expect(result).toBe(3);
    expect(mockHincrby).toHaveBeenCalledWith(
      "review:job-1:status",
      "followUpCount",
      1,
    );
  });
});

describe("getStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for missing key", async () => {
    mockHgetall.mockResolvedValue({});
    const redis = { hset: mockHset, hgetall: mockHgetall, hincrby: mockHincrby } as any;

    const result = await getStatus(redis, "nonexistent");

    expect(result).toBeNull();
    expect(mockHgetall).toHaveBeenCalledWith("review:nonexistent:status");
  });

  it("returns parsed ReviewJobStatus for existing key", async () => {
    mockHgetall.mockResolvedValue({
      jobId: "job-1",
      status: "reviewing",
      podName: "reviewer-job-1",
      createdAt: "2026-08-03T00:00:00Z",
      followUpCount: "2",
    });
    const redis = { hset: mockHset, hgetall: mockHgetall, hincrby: mockHincrby } as any;

    const result = await getStatus(redis, "job-1");

    expect(result).not.toBeNull();
    expect(result!.status).toBe("reviewing");
    expect(result!.jobId).toBe("job-1");
    expect(result!.followUpCount).toBe(2);
  });
});
