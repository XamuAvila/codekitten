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

  describe("issue_comment", () => {
    function commentPayload(body: string, overrides?: Record<string, unknown>) {
      return {
        action: "created",
        issue: { number: 42, pull_request: { url: "https://api.github.com/..." } },
        comment: { body, user: { login: "dev", type: "User" } },
        repository: { full_name: "octo/repo" },
        sender: { login: "dev", type: "User" },
        ...overrides,
      };
    }

    it("@reviewer force on an active job → publishes follow_up 'force'", async () => {
      setActiveStatus("review-octo-repo-42", "reviewing");

      const result = await routeEvent("issue_comment", commentPayload("@reviewer force"), deps);

      expect(publish).toHaveBeenCalledTimes(1);
      const [channel, raw] = publish.mock.calls[0];
      expect(channel).toBe("review:review-octo-repo-42:messages");
      const msg = JSON.parse(raw);
      expect(msg.type).toBe("follow_up");
      expect(msg.payload).toEqual({ message: "force", sender: "dev" });
      expect(result.status).toBe("sent");
    });

    it("@reviewer stop → publishes 'stop'", async () => {
      setActiveStatus("review-octo-repo-42", "reviewing");

      await routeEvent("issue_comment", commentPayload("@Reviewer STOP"), deps);

      expect(JSON.parse(publish.mock.calls[0][1]).payload.message).toBe("stop");
    });

    it("@reviewer <question> → follow-up with trigger stripped", async () => {
      setActiveStatus("review-octo-repo-42", "reviewing");

      await routeEvent(
        "issue_comment",
        commentPayload("@reviewer why is finding 2 relevant?"),
        deps,
      );

      expect(JSON.parse(publish.mock.calls[0][1]).payload.message).toBe("why is finding 2 relevant?");
    });

    it("comment without the trigger → ignored", async () => {
      setActiveStatus("review-octo-repo-42", "reviewing");
      const result = await routeEvent("issue_comment", commentPayload("nice PR!"), deps);
      expect(result).toEqual({ ignored: true });
      expect(publish).not.toHaveBeenCalled();
    });

    it("bot author → ignored (feedback-loop guard)", async () => {
      setActiveStatus("review-octo-repo-42", "reviewing");
      const payload = commentPayload("@reviewer force", {
        comment: { body: "@reviewer force", user: { login: "kitten[bot]", type: "Bot" } },
        sender: { login: "kitten[bot]", type: "Bot" },
      });

      const result = await routeEvent("issue_comment", payload, deps);

      expect(result).toEqual({ ignored: true });
      expect(publish).not.toHaveBeenCalled();
    });

    it("comment on a plain issue (no pull_request) → ignored", async () => {
      setActiveStatus("review-octo-repo-42", "reviewing");
      const payload = commentPayload("@reviewer force", { issue: { number: 42 } });

      const result = await routeEvent("issue_comment", payload, deps);

      expect(result).toEqual({ ignored: true });
    });

    it("terminal/unknown job → ignored with log, no error", async () => {
      const result = await routeEvent("issue_comment", commentPayload("@reviewer force"), deps);
      expect(result).toEqual({ ignored: true });
      expect(publish).not.toHaveBeenCalled();
    });

    describe("remember command (KIT-037)", () => {
      let insert: ReturnType<typeof vi.fn>;

      beforeEach(() => {
        insert = vi.fn().mockResolvedValue(undefined);
        deps = { ...deps, knowledgeClient: { insert } as never };
      });

      it("@reviewer remember <text> → knowledge insert with source command", async () => {
        const result = await routeEvent(
          "issue_comment",
          commentPayload("@reviewer remember we always use zod for validation"),
          deps,
        );

        expect(insert).toHaveBeenCalledWith({
          repo: "octo/repo",
          text: "we always use zod for validation",
          source: "command",
          author: "dev",
          prNumber: 42,
        });
        expect(result.status).toBe("stored");
        expect(publish).not.toHaveBeenCalled();
      });

      it("works without an active review job (repo-scoped, not job-scoped)", async () => {
        const result = await routeEvent("issue_comment", commentPayload("@reviewer remember fact"), deps);
        expect(insert).toHaveBeenCalledTimes(1);
        expect(result.status).toBe("stored");
      });

      it("empty remember text → ignored + log, nothing stored", async () => {
        const result = await routeEvent("issue_comment", commentPayload("@reviewer remember   "), deps);
        expect(insert).not.toHaveBeenCalled();
        expect(result).toEqual({ ignored: true });
      });

      it("no knowledge client configured → ignored with warning, no crash", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        deps = { ...deps, knowledgeClient: undefined };

        const result = await routeEvent("issue_comment", commentPayload("@reviewer remember fact"), deps);

        expect(result).toEqual({ ignored: true });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("knowledge"));
        warn.mockRestore();
      });

      it("insert failure → ignored with warning, delivery still acknowledged", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        insert.mockRejectedValue(new Error("atlas down"));

        const result = await routeEvent("issue_comment", commentPayload("@reviewer remember fact"), deps);

        expect(result).toEqual({ ignored: true });
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
      });

      it("bot author remember → ignored (existing bot filter)", async () => {
        const payload = commentPayload("@reviewer remember fact", {
          comment: { body: "@reviewer remember fact", user: { login: "kitten[bot]", type: "Bot" } },
        });
        const result = await routeEvent("issue_comment", payload, deps);
        expect(insert).not.toHaveBeenCalled();
        expect(result).toEqual({ ignored: true });
      });
    });
  });
});
