import { describe, it, expect, vi, beforeEach } from "vitest";

import { routeEvent } from "../src/webhook/events.js";
import type { EventRouterDeps } from "../src/webhook/events.js";
import type { K8sClient } from "../src/k8s/client.js";
import type { PodConfig } from "../src/k8s/manifest.js";

const podConfig: PodConfig = {
  namespace: "kitten",
  image: "kitten-reviewer:latest",
  idleTimeoutMs: 600000,
  redisUrl: "redis://localhost:6379",
};

function prPayload(action: string, overrides?: Record<string, unknown>) {
  return {
    action,
    pull_request: {
      number: 42,
      state: "open",
      head: { ref: "feat/x" },
      base: { ref: "main" },
    },
    repository: { full_name: "octo/repo" },
    sender: { login: "dev", type: "User" },
    ...overrides,
  };
}

describe("routeEvent — pull_request", () => {
  let deps: EventRouterDeps;
  let createPod: ReturnType<typeof vi.fn>;
  let publish: ReturnType<typeof vi.fn>;
  let statusStore: Map<string, string>;

  beforeEach(() => {
    createPod = vi.fn().mockResolvedValue({});
    publish = vi.fn().mockResolvedValue(1);
    statusStore = new Map();
    deps = {
      k8sClient: { createPod } as unknown as K8sClient,
      redis: {
        get: vi.fn((key: string) => Promise.resolve(statusStore.get(key) ?? null)),
        set: vi.fn((key: string, value: string) => {
          statusStore.set(key, value);
          return Promise.resolve("OK");
        }),
        publish,
      } as unknown as EventRouterDeps["redis"],
      podConfig,
      triggerWord: "@reviewer",
    };
  });

  function setActiveStatus(jobId: string, status: string) {
    statusStore.set(
      `review:${jobId}:status`,
      JSON.stringify({ jobId, status, podName: jobId, createdAt: "t", followUpCount: 0 }),
    );
  }

  it("opened with no active job → dispatches a Pod and stores status", async () => {
    const result = await routeEvent("pull_request", prPayload("opened"), deps);

    expect(createPod).toHaveBeenCalledTimes(1);
    expect(result.jobId).toBe("review-octo-repo-42");
    expect(result.status).toBe("queued");
    expect(statusStore.has("review:review-octo-repo-42:status")).toBe(true);
  });

  it("synchronize with an active job → publishes re_review, no Pod", async () => {
    setActiveStatus("review-octo-repo-42", "reviewing");

    const result = await routeEvent("pull_request", prPayload("synchronize"), deps);

    expect(createPod).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    const [channel, raw] = publish.mock.calls[0];
    expect(channel).toBe("review:review-octo-repo-42:messages");
    expect(JSON.parse(raw).type).toBe("re_review");
    expect(result.status).toBe("re_review");
  });

  it("re_review publish with 0 subscribers → falls back to a new Pod", async () => {
    setActiveStatus("review-octo-repo-42", "reviewing");
    publish.mockResolvedValue(0);

    const result = await routeEvent("pull_request", prPayload("synchronize"), deps);

    expect(createPod).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("queued");
  });

  it("terminal job status → new Pod (no publish)", async () => {
    setActiveStatus("review-octo-repo-42", "completed");

    await routeEvent("pull_request", prPayload("synchronize"), deps);

    expect(publish).not.toHaveBeenCalled();
    expect(createPod).toHaveBeenCalledTimes(1);
  });

  it("closed action → ignored", async () => {
    const result = await routeEvent("pull_request", prPayload("closed"), deps);
    expect(result).toEqual({ ignored: true });
    expect(createPod).not.toHaveBeenCalled();
  });

  it("malformed payload → ignored with warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await routeEvent("pull_request", { action: "opened" }, deps);

    expect(result).toEqual({ ignored: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("pull_request"));
    warn.mockRestore();
  });

  it("unknown event type → ignored", async () => {
    const result = await routeEvent("star", {}, deps);
    expect(result).toEqual({ ignored: true });
  });
});
