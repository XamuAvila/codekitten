import { describe, it, expect } from "vitest";
import { buildPodManifest, buildPodName } from "../../src/k8s/manifest.js";
import type { PodConfig } from "../../src/k8s/manifest.js";
import type { ReviewJob } from "@kitten/shared";

const sampleJob: ReviewJob = {
  repo: "octocat/Hello-World",
  prNumber: 1,
  headRef: "main",
  baseRef: "main~1",
  sender: "test",
  isReReview: false,
};

const sampleConfig: PodConfig = {
  namespace: "kitten",
  image: "ghcr.io/kitten/reviewer:latest",
  idleTimeoutMs: 300_000,
  redisUrl: "redis://redis.kitten.svc.cluster.local:6379",
};

describe("buildPodManifest", () => {
  it("returns V1Pod with correct metadata", () => {
    const pod = buildPodManifest(sampleJob, sampleConfig);

    expect(pod.metadata?.name).toBe("review-octocat-hello-world-1");
    expect(pod.metadata?.namespace).toBe("kitten");
    expect(pod.metadata?.labels).toEqual({
      app: "kitten-reviewer",
      "review-job-id": "review-octocat-hello-world-1",
    });
  });

  it("sets container image from config", () => {
    const pod = buildPodManifest(sampleJob, sampleConfig);
    const container = pod.spec?.containers[0];

    expect(container).toBeDefined();
    expect(container?.image).toBe("ghcr.io/kitten/reviewer:latest");
  });

  it("injects job envs", () => {
    const pod = buildPodManifest(sampleJob, sampleConfig);
    const envVars = pod.spec?.containers[0]?.env ?? [];

    const envMap = new Map(envVars.map((e) => [e.name, e.value]));

    expect(envMap.get("REVIEW_JOB_ID")).toBe("review-octocat-hello-world-1");
    expect(envMap.get("REVIEW_REPO")).toBe("octocat/Hello-World");
    expect(envMap.get("REVIEW_PR_NUMBER")).toBe("1");
    expect(envMap.get("REVIEW_HEAD_REF")).toBe("main");
    expect(envMap.get("REVIEW_BASE_REF")).toBe("main~1");
    expect(envMap.get("REVIEW_SENDER")).toBe("test");
    expect(envMap.get("REDIS_URL")).toBe(
      "redis://redis.kitten.svc.cluster.local:6379",
    );
    expect(envMap.get("POD_IDLE_TIMEOUT_MS")).toBe("300000");
  });

  it("references GITHUB_TOKEN from secret", () => {
    const pod = buildPodManifest(sampleJob, sampleConfig);
    const envVars = pod.spec?.containers[0]?.env ?? [];

    const tokenEnv = envVars.find((e) => e.name === "GITHUB_TOKEN");

    expect(tokenEnv).toBeDefined();
    expect(tokenEnv?.value).toBeUndefined();
    expect(tokenEnv?.valueFrom?.secretKeyRef).toEqual({
      name: "kitten-github-token",
      key: "token",
    });
  });

  it("sets resource limits", () => {
    const pod = buildPodManifest(sampleJob, sampleConfig);
    const resources = pod.spec?.containers[0]?.resources;

    expect(resources?.requests).toEqual({
      cpu: "250m",
      memory: "512Mi",
    });
    expect(resources?.limits).toEqual({
      cpu: "1",
      memory: "1Gi",
    });
  });

  it("sets restartPolicy to Never", () => {
    const pod = buildPodManifest(sampleJob, sampleConfig);

    expect(pod.spec?.restartPolicy).toBe("Never");
  });
});

describe("buildPodName", () => {
  it("produces lowercase deterministic name from repo and PR", () => {
    expect(buildPodName("octocat/Hello-World", 1)).toBe(
      "review-octocat-hello-world-1",
    );
  });

  it("handles different repos and PR numbers", () => {
    expect(buildPodName("org/My-Repo", 42)).toBe("review-org-my-repo-42");
  });
});
