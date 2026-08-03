import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mock redis/pubsub ---
const mockUnsubscribe = vi.fn().mockResolvedValue(undefined);
const mockSubscribeToChannel = vi.fn().mockResolvedValue({ unsubscribe: mockUnsubscribe });

vi.mock("../src/redis/pubsub.js", () => ({
  subscribeToChannel: (...args: unknown[]) => mockSubscribeToChannel(...args),
}));

// --- Mock redis/status ---
const mockReportStatus = vi.fn().mockResolvedValue(undefined);
const mockIncrementFollowUpCount = vi.fn().mockResolvedValue(1);

vi.mock("../src/redis/status.js", () => ({
  reportStatus: (...args: unknown[]) => mockReportStatus(...args),
  incrementFollowUpCount: (...args: unknown[]) => mockIncrementFollowUpCount(...args),
}));

// --- Mock ioredis ---
const mockRedisQuit = vi.fn().mockResolvedValue(undefined);

vi.mock("ioredis", () => {
  function createInstance() {
    return {
      quit: (...args: unknown[]) => mockRedisQuit(...args),
      duplicate: () => createInstance(),
    };
  }

  // Must be a class/constructor — ioredis is used via `new Redis(url)`
  return {
    Redis: class MockRedis {
      quit = (...args: unknown[]) => mockRedisQuit(...args);
      duplicate = () => createInstance();
      constructor(_url?: string) {}
    },
  };
});

// --- Mock github/comment ---
const mockPostFollowUpAck = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/github/comment.js", () => ({
  postFollowUpAck: (...args: unknown[]) => mockPostFollowUpAck(...args),
}));

// --- Mock process.exit ---
const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

import { startAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/agent.js";

const baseConfig: AgentConfig = {
  jobId: "test-job-1",
  redisUrl: "redis://localhost:6379",
  idleTimeoutMs: 5000,
};

describe("startAgent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Restore default mock for subscribeToChannel
    mockSubscribeToChannel.mockResolvedValue({ unsubscribe: mockUnsubscribe });
  });

  afterEach(() => {
    vi.useRealTimers();
    // Remove SIGTERM listeners added by agent
    process.removeAllListeners("SIGTERM");
  });

  it("subscribes to the correct Redis channel", async () => {
    const agentPromise = startAgent(baseConfig);

    // Let microtasks settle
    await vi.advanceTimersByTimeAsync(0);

    expect(mockSubscribeToChannel).toHaveBeenCalledWith(
      expect.anything(),
      "review:test-job-1:messages",
      expect.any(Function),
    );

    // Trigger idle timeout to end the agent
    await vi.advanceTimersByTimeAsync(5000);
    await agentPromise;
  });

  it("reports 'reviewing' status on start", async () => {
    const agentPromise = startAgent(baseConfig);
    await vi.advanceTimersByTimeAsync(0);

    expect(mockReportStatus).toHaveBeenCalledWith(
      expect.anything(),
      "test-job-1",
      "reviewing",
    );

    await vi.advanceTimersByTimeAsync(5000);
    await agentPromise;
  });

  it("shuts down after idle timeout", async () => {
    const agentPromise = startAgent(baseConfig);
    await vi.advanceTimersByTimeAsync(0);

    // Not yet timed out
    expect(mockExit).not.toHaveBeenCalled();

    // Advance past idle timeout
    await vi.advanceTimersByTimeAsync(5000);
    await agentPromise;

    expect(mockReportStatus).toHaveBeenCalledWith(
      expect.anything(),
      "test-job-1",
      "completed",
    );
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("resets idle timer on follow_up message", async () => {
    // Capture the handler passed to subscribeToChannel
    let capturedHandler: ((msg: any) => void) | undefined;
    mockSubscribeToChannel.mockImplementation(async (_sub: any, _ch: any, handler: any) => {
      capturedHandler = handler;
      return { unsubscribe: mockUnsubscribe };
    });

    const agentPromise = startAgent(baseConfig);
    await vi.advanceTimersByTimeAsync(0);

    expect(capturedHandler).toBeDefined();

    // At t=3000, send a follow_up message (resets timer)
    await vi.advanceTimersByTimeAsync(3000);
    capturedHandler!({
      type: "follow_up",
      payload: { message: "explain", sender: "alice" },
      timestamp: "2026-08-03T00:00:00Z",
    });

    // At t=5000 (original timeout) — should NOT have exited
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockExit).not.toHaveBeenCalled();

    // At t=8000 (3000 + 5000 = new timeout) — should exit
    await vi.advanceTimersByTimeAsync(3000);
    await agentPromise;

    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("increments follow-up counter on follow_up message", async () => {
    let capturedHandler: ((msg: any) => void) | undefined;
    mockSubscribeToChannel.mockImplementation(async (_sub: any, _ch: any, handler: any) => {
      capturedHandler = handler;
      return { unsubscribe: mockUnsubscribe };
    });

    const agentPromise = startAgent(baseConfig);
    await vi.advanceTimersByTimeAsync(0);

    capturedHandler!({
      type: "follow_up",
      payload: { message: "why?", sender: "bob" },
      timestamp: "2026-08-03T00:00:00Z",
    });

    expect(mockIncrementFollowUpCount).toHaveBeenCalledWith(
      expect.anything(),
      "test-job-1",
    );

    await vi.advanceTimersByTimeAsync(5000);
    await agentPromise;
  });

  it("exits immediately on shutdown message", async () => {
    let capturedHandler: ((msg: any) => void) | undefined;
    mockSubscribeToChannel.mockImplementation(async (_sub: any, _ch: any, handler: any) => {
      capturedHandler = handler;
      return { unsubscribe: mockUnsubscribe };
    });

    const agentPromise = startAgent(baseConfig);
    await vi.advanceTimersByTimeAsync(0);

    capturedHandler!({
      type: "shutdown",
      payload: {},
      timestamp: "2026-08-03T00:00:00Z",
    });

    // Let async shutdown complete
    await vi.advanceTimersByTimeAsync(0);
    await agentPromise;

    expect(mockReportStatus).toHaveBeenCalledWith(
      expect.anything(),
      "test-job-1",
      "completed",
    );
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("dispatches force command to onForce exactly once", async () => {
    let capturedHandler: ((msg: any) => void) | undefined;
    mockSubscribeToChannel.mockImplementation(async (_sub: any, _ch: any, handler: any) => {
      capturedHandler = handler;
      return { unsubscribe: mockUnsubscribe };
    });

    const onForce = vi.fn().mockResolvedValue(undefined);
    const agentPromise = startAgent({ ...baseConfig, onForce });
    await vi.advanceTimersByTimeAsync(0);

    capturedHandler!({
      type: "follow_up",
      payload: { message: "force", sender: "alice" },
      timestamp: "2026-08-03T00:00:00Z",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(onForce).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    await agentPromise;
  });

  it("does not dispatch onForce for a regular follow-up question", async () => {
    let capturedHandler: ((msg: any) => void) | undefined;
    mockSubscribeToChannel.mockImplementation(async (_sub: any, _ch: any, handler: any) => {
      capturedHandler = handler;
      return { unsubscribe: mockUnsubscribe };
    });

    const onForce = vi.fn().mockResolvedValue(undefined);
    const agentPromise = startAgent({ ...baseConfig, onForce });
    await vi.advanceTimersByTimeAsync(0);

    capturedHandler!({
      type: "follow_up",
      payload: { message: "explain the changes", sender: "alice" },
      timestamp: "2026-08-03T00:00:00Z",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(onForce).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    await agentPromise;
  });

  it("dispatches stop command to onStop exactly once", async () => {
    let capturedHandler: ((msg: any) => void) | undefined;
    mockSubscribeToChannel.mockImplementation(async (_sub: any, _ch: any, handler: any) => {
      capturedHandler = handler;
      return { unsubscribe: mockUnsubscribe };
    });

    const onStop = vi.fn().mockResolvedValue(undefined);
    const agentPromise = startAgent({ ...baseConfig, onStop });
    await vi.advanceTimersByTimeAsync(0);

    capturedHandler!({
      type: "follow_up",
      payload: { message: "stop", sender: "alice" },
      timestamp: "2026-08-03T00:00:00Z",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(onStop).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    await agentPromise;
  });

  it("does not dispatch onStop for a regular follow-up question", async () => {
    let capturedHandler: ((msg: any) => void) | undefined;
    mockSubscribeToChannel.mockImplementation(async (_sub: any, _ch: any, handler: any) => {
      capturedHandler = handler;
      return { unsubscribe: mockUnsubscribe };
    });

    const onStop = vi.fn().mockResolvedValue(undefined);
    const agentPromise = startAgent({ ...baseConfig, onStop });
    await vi.advanceTimersByTimeAsync(0);

    capturedHandler!({
      type: "follow_up",
      payload: { message: "why?", sender: "alice" },
      timestamp: "2026-08-03T00:00:00Z",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(onStop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    await agentPromise;
  });

  it("matches force case-insensitively with surrounding whitespace", async () => {
    let capturedHandler: ((msg: any) => void) | undefined;
    mockSubscribeToChannel.mockImplementation(async (_sub: any, _ch: any, handler: any) => {
      capturedHandler = handler;
      return { unsubscribe: mockUnsubscribe };
    });

    const onForce = vi.fn().mockResolvedValue(undefined);
    const agentPromise = startAgent({ ...baseConfig, onForce });
    await vi.advanceTimersByTimeAsync(0);

    capturedHandler!({
      type: "follow_up",
      payload: { message: "  FORCE  ", sender: "alice" },
      timestamp: "2026-08-03T00:00:00Z",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(onForce).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    await agentPromise;
  });

  it("handles SIGTERM gracefully", async () => {
    const agentPromise = startAgent(baseConfig);
    await vi.advanceTimersByTimeAsync(0);

    // Simulate SIGTERM
    process.emit("SIGTERM", "SIGTERM");

    // Let async cleanup complete
    await vi.advanceTimersByTimeAsync(0);
    await agentPromise;

    expect(mockReportStatus).toHaveBeenCalledWith(
      expect.anything(),
      "test-job-1",
      "completed",
    );
    expect(mockUnsubscribe).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(0);
  });
});
