import { describe, it, expect, vi } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ size: 0 })),
  rmSync: vi.fn(),
}));

vi.mock("simple-git", () => ({
  default: () => ({ clone: vi.fn(() => Promise.resolve()) }),
  simpleGit: () => ({ clone: vi.fn(() => Promise.resolve()) }),
}));

import { runPipeline } from "../../src/pipeline.js";
import type { ReviewJob } from "@kitten/shared";
import { DEFAULT_CONFIG } from "@kitten/shared";

const job: ReviewJob = {
  repo: "octocat/Hello-World",
  prNumber: 42,
  headRef: "main",
  baseRef: "main~1",
  sender: "test",
  isReReview: false,
};

describe("runPipeline", () => {
  it("returns completed or failed with metadata", async () => {
    const result = await runPipeline(job, DEFAULT_CONFIG, "/tmp/test-pipeline");

    expect(["completed", "failed"]).toContain(result.status);
    expect(result.metadata.repo).toBe("octocat/Hello-World");
    expect(result.metadata.prNumber).toBe(42);
  });

  it("includes duration in metadata", async () => {
    const result = await runPipeline(job, DEFAULT_CONFIG, "/tmp/test-pipeline-2");

    expect(typeof result.metadata.durationMs).toBe("number");
    expect(result.metadata.durationMs).toBeGreaterThanOrEqual(0);
  });
});
