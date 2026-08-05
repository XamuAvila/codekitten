import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PubSubMessage } from "@kitten/shared";

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
      // `new Redis(url)` — the url arg is required by the real constructor but
      // unused in the mock. `_url` alone does not silence the rule here.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      constructor(_url?: string) {}
    },
  };
});

// --- Mock github/comment ---
const mockPostFollowUpAnswer = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/github/comment.js", () => ({
  postFollowUpAnswer: (...args: unknown[]) => mockPostFollowUpAnswer(...args),
}));

// --- Mock LLM adapter (via createLlmAdapter mock) ---
const { mockCreateLlmAdapter, mockRespond } = vi.hoisted(() => ({
  mockCreateLlmAdapter: vi.fn(),
  mockRespond: vi.fn(),
}));

vi.mock("@kitten/shared", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@kitten/shared")>();
  return {
    ...mod,
    createLlmAdapter: mockCreateLlmAdapter,
  };
});

// --- Mock process.exit ---
const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as () => never);

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
    // Restore default mocks wiped by clearAllMocks
    mockSubscribeToChannel.mockResolvedValue({ unsubscribe: mockUnsubscribe });
    mockCreateLlmAdapter.mockReturnValue({ review: vi.fn(), respond: vi.fn() });
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
    let capturedHandler: ((msg: PubSubMessage) => void) | undefined;
    mockSubscribeToChannel.mockImplementation(
      async (_sub: unknown, _ch: unknown, handler: (msg: PubSubMessage) => void) => {
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
    let capturedHandler: ((msg: PubSubMessage) => void) | undefined;
    mockSubscribeToChannel.mockImplementation(
      async (_sub: unknown, _ch: unknown, handler: (msg: PubSubMessage) => void) => {
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
    let capturedHandler: ((msg: PubSubMessage) => void) | undefined;
    mockSubscribeToChannel.mockImplementation(
      async (_sub: unknown, _ch: unknown, handler: (msg: PubSubMessage) => void) => {
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
    let capturedHandler: ((msg: PubSubMessage) => void) | undefined;
    mockSubscribeToChannel.mockImplementation(
      async (_sub: unknown, _ch: unknown, handler: (msg: PubSubMessage) => void) => {
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

  it("dispatches re_review message to onReReview and resets the idle timer", async () => {
    let capturedHandler: ((msg: PubSubMessage) => void) | undefined;
    mockSubscribeToChannel.mockImplementation(
      async (_sub: unknown, _ch: unknown, handler: (msg: PubSubMessage) => void) => {
      capturedHandler = handler;
      return { unsubscribe: mockUnsubscribe };
    });

    const onReReview = vi.fn().mockResolvedValue(undefined);
    const agentPromise = startAgent({ ...baseConfig, onReReview });
    await vi.advanceTimersByTimeAsync(0);

    // Just before the idle timeout, a re_review arrives — timer must reset
    await vi.advanceTimersByTimeAsync(4000);
    capturedHandler!({ type: "re_review", payload: {}, timestamp: "t" });
    await vi.advanceTimersByTimeAsync(0);

    expect(onReReview).toHaveBeenCalledTimes(1);

    // 4s later the agent is still alive (timer was reset at 4s)
    await vi.advanceTimersByTimeAsync(4000);
    expect(mockExit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    await agentPromise;
  });

  it("serializeReruns: concurrent calls queue at most one pending re-run", async () => {
    const { serializeReruns } = await import("../src/agent.js");
    let resolveFirst: () => void;
    const first = new Promise<void>((r) => (resolveFirst = r));
    const runs: number[] = [];
    let call = 0;
    const fn = vi.fn().mockImplementation(() => {
      call += 1;
      runs.push(call);
      return call === 1 ? first : Promise.resolve();
    });
    const serialized = serializeReruns(fn);

    void serialized(); // starts run 1
    void serialized(); // queued
    void serialized(); // collapsed into the same queued run
    expect(fn).toHaveBeenCalledTimes(1);

    resolveFirst!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(fn).toHaveBeenCalledTimes(2); // 1 running + 1 queued, third collapsed
  });

  it("does not dispatch onForce for a regular follow-up question", async () => {
    let capturedHandler: ((msg: PubSubMessage) => void) | undefined;
    mockSubscribeToChannel.mockImplementation(
      async (_sub: unknown, _ch: unknown, handler: (msg: PubSubMessage) => void) => {
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
    let capturedHandler: ((msg: PubSubMessage) => void) | undefined;
    mockSubscribeToChannel.mockImplementation(
      async (_sub: unknown, _ch: unknown, handler: (msg: PubSubMessage) => void) => {
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
    let capturedHandler: ((msg: PubSubMessage) => void) | undefined;
    mockSubscribeToChannel.mockImplementation(
      async (_sub: unknown, _ch: unknown, handler: (msg: PubSubMessage) => void) => {
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

  it("answers a follow-up question with the LLM using review context", async () => {
    let capturedHandler: ((msg: PubSubMessage) => void) | undefined;
    mockSubscribeToChannel.mockImplementation(
      async (_sub: unknown, _ch: unknown, handler: (msg: PubSubMessage) => void) => {
      capturedHandler = handler;
      return { unsubscribe: mockUnsubscribe };
    });

    mockRespond.mockResolvedValue("The change moves validation to the service layer.");
    mockCreateLlmAdapter.mockReturnValue({ review: vi.fn(), respond: mockRespond });

    const reviewContext = {
      findings: [{ severity: "high" as const, file: "a.ts", line: 1, finding: "Bug" }],
      prompt: { system: "guardrailed system", user: "diff + files" },
    };

    const agentPromise = startAgent({
      ...baseConfig,
      token: "token",
      repo: "org/repo",
      prNumber: 5,
      reviewContext,
      llmConfig: {
        provider: "anthropic" as const,
        baseUrl: "https://api.deepseek.com/anthropic",
        model: "deepseek-v4-flash",
        maxContextTokens: 1_000_000,
        maxOutputTokens: 16_000,
        maxFindings: 20,
        maxComplexity: 10,
        language: "en",
        trigger: "@reviewer",
        blocking: "comment_only" as const,
        skip: [],
        conventionsFile: "CLAUDE.md",
        rules: [],
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    capturedHandler!({
      type: "follow_up",
      payload: { message: "explain finding 1", sender: "alice" },
      timestamp: "2026-08-03T00:00:00Z",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(mockCreateLlmAdapter).toHaveBeenCalledTimes(1);
    expect(mockRespond).toHaveBeenCalledTimes(1);
    const [system, user, maxTokens] = mockRespond.mock.calls[0];
    expect(system).toContain("guardrailed system");
    expect(user).toContain("explain finding 1");
    expect(user).toContain("Bug"); // findings in context
    expect(maxTokens).toBeGreaterThan(0);

    expect(mockPostFollowUpAnswer).toHaveBeenCalledWith("token", "org/repo", 5, "The change moves validation to the service layer.");

    await vi.advanceTimersByTimeAsync(5000);
    await agentPromise;
  });

  it("hands the review system prompt, language rule included, to the follow-up call", async () => {
    // The agent never rebuilds the prompt — it replays the one the pipeline
    // produced. This locks that pass-through so a future refactor cannot
    // answer follow-ups in a different language than the review itself.
    // Typed rather than `any` like its neighbours: this file already carries
    // 42 no-explicit-any errors (KIT-021) and new tests should not add more.
    let capturedHandler: ((msg: PubSubMessage) => void) | undefined;
    mockSubscribeToChannel.mockImplementation(
      async (_sub: unknown, _ch: unknown, handler: (msg: PubSubMessage) => void) => {
        capturedHandler = handler;
        return { unsubscribe: mockUnsubscribe };
      },
    );

    mockRespond.mockResolvedValue("Resposta em portugues.");
    mockCreateLlmAdapter.mockReturnValue({ review: vi.fn(), respond: mockRespond });

    const agentPromise = startAgent({
      ...baseConfig,
      token: "token",
      repo: "org/repo",
      prNumber: 5,
      reviewContext: {
        findings: [],
        prompt: {
          system: 'LANGUAGE:\n- Write every piece of prose you author in "pt".',
          user: "diff + files",
        },
      },
      llmConfig: {
        provider: "anthropic" as const,
        baseUrl: "https://api.deepseek.com/anthropic",
        model: "deepseek-v4-flash",
        maxContextTokens: 1_000_000,
        maxOutputTokens: 16_000,
        maxFindings: 20,
        maxComplexity: 10,
        language: "pt",
        trigger: "@reviewer",
        blocking: "comment_only" as const,
        skip: [],
        conventionsFile: "CLAUDE.md",
        rules: [],
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    capturedHandler!({
      type: "follow_up",
      payload: { message: "explique o primeiro finding", sender: "alice" },
      timestamp: "2026-08-04T00:00:00Z",
    });
    await vi.advanceTimersByTimeAsync(0);

    const [system] = mockRespond.mock.calls[0];
    expect(system).toContain("LANGUAGE:");
    expect(system).toContain('"pt"');

    await vi.advanceTimersByTimeAsync(5000);
    await agentPromise;
  });

  it("keeps the agent alive when the follow-up LLM call fails", async () => {
    let capturedHandler: ((msg: PubSubMessage) => void) | undefined;
    mockSubscribeToChannel.mockImplementation(
      async (_sub: unknown, _ch: unknown, handler: (msg: PubSubMessage) => void) => {
      capturedHandler = handler;
      return { unsubscribe: mockUnsubscribe };
    });

    mockRespond.mockRejectedValue(new Error("LLM down"));
    mockCreateLlmAdapter.mockReturnValue({ review: vi.fn(), respond: mockRespond });

    const agentPromise = startAgent({
      ...baseConfig,
      reviewContext: { findings: [], prompt: { system: "s", user: "u" } },
    });
    await vi.advanceTimersByTimeAsync(0);

    capturedHandler!({
      type: "follow_up",
      payload: { message: "why?", sender: "alice" },
      timestamp: "2026-08-03T00:00:00Z",
    });
    await vi.advanceTimersByTimeAsync(0);

    // Agent still alive: not exited, not shutdown
    expect(mockExit).not.toHaveBeenCalled();
    expect(mockPostFollowUpAnswer).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    await agentPromise;
  });

  it("matches force case-insensitively with surrounding whitespace", async () => {
    let capturedHandler: ((msg: PubSubMessage) => void) | undefined;
    mockSubscribeToChannel.mockImplementation(
      async (_sub: unknown, _ch: unknown, handler: (msg: PubSubMessage) => void) => {
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
