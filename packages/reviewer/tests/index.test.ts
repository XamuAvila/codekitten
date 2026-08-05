import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock pipeline + agent + redis before importing index
const { mockRunPipeline, mockStartAgent, mockReportStatus } = vi.hoisted(() => ({
  mockRunPipeline: vi.fn(),
  mockStartAgent: vi.fn(),
  mockReportStatus: vi.fn(),
}));

vi.mock("../src/pipeline.js", () => ({
  runPipeline: (...args: unknown[]) => mockRunPipeline(...args),
}));

vi.mock("../src/agent.js", () => ({
  startAgent: (...args: unknown[]) => mockStartAgent(...args),
  serializeReruns: (fn: () => Promise<void>) => fn,
}));

vi.mock("../src/redis/status.js", () => ({
  reportStatus: (...args: unknown[]) => mockReportStatus(...args),
}));

vi.mock("../src/redis/pubsub.js", () => ({
  subscribeToChannel: vi.fn().mockResolvedValue({ unsubscribe: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock("ioredis", () => {
  return {
    Redis: class MockRedis {
      duplicate = () => new (class { quit = () => Promise.resolve(undefined); })();
      quit = () => Promise.resolve(undefined);
    },
  };
});

// process.exit is mocked to THROW — matches real semantics (exits the process),
// so code after exit(1) never runs
const mockExit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
  throw new Error(`process.exit(${code})`);
}) as never);

import { main } from "../src/index.js";

const ENVS = {
  REVIEW_JOB_ID: "review-org-repo-1",
  REVIEW_REPO: "org/repo",
  REVIEW_PR_NUMBER: "1",
  REVIEW_HEAD_REF: "head",
  REVIEW_BASE_REF: "base",
  REVIEW_SENDER: "test",
  GITHUB_TOKEN: "token",
  REDIS_URL: "redis://localhost:6379",
};

describe("main (entrypoint)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const [k, v] of Object.entries(ENVS)) process.env[k] = v;
    delete process.env["POD_IDLE_TIMEOUT_MS"];
    mockRunPipeline.mockResolvedValue({
      status: "completed",
      dryRun: false,
      findings: [],
      prompt: { system: "s", user: "u" },
      llmConfig: {},
      metadata: { repo: "org/repo", prNumber: 1, durationMs: 10 },
    });
    mockStartAgent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const k of Object.keys(ENVS)) delete process.env[k];
  });

  it("reports running, runs the pipeline, then starts the agent", async () => {
    await main();

    expect(mockReportStatus).toHaveBeenCalledWith(expect.anything(), "review-org-repo-1", "running");
    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    expect(mockStartAgent).toHaveBeenCalledTimes(1);
    const [agentConfig] = mockStartAgent.mock.calls[0];
    expect(agentConfig.jobId).toBe("review-org-repo-1");
    expect(agentConfig.reviewContext).toBeDefined();
    expect(agentConfig.llmConfig).toBeDefined();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("exits 1 when the pipeline fails", async () => {
    mockRunPipeline.mockResolvedValue({
      status: "failed",
      dryRun: false,
      error: "boom",
      metadata: { repo: "org/repo", prNumber: 1, durationMs: 10 },
    });

    try {
      await main();
      expect.unreachable("should have exited");
    } catch (error) {
      expect((error as Error).message).toContain("process.exit(1)");
    }

    expect(mockReportStatus).toHaveBeenCalledWith(expect.anything(), "review-org-repo-1", "failed");
    expect(mockStartAgent).not.toHaveBeenCalled();
  });
});
