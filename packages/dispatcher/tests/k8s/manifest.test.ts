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

  it("references the three LLM keys from the kitten-llm-keys secret", () => {
    const pod = buildPodManifest(sampleJob, sampleConfig);
    const envVars = pod.spec?.containers[0]?.env ?? [];

    for (const [envName, key] of [
      ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
      ["OPENAI_API_KEY", "OPENAI_API_KEY"],
      ["DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"],
    ] as const) {
      const env = envVars.find((e) => e.name === envName);

      expect(env).toBeDefined();
      expect(env?.value).toBeUndefined();
      expect(env?.valueFrom?.secretKeyRef).toEqual({
        name: "kitten-llm-keys",
        key,
      });
    }
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

describe("buildPodManifest — semble sidecar (KIT-036)", () => {
  const sidecarConfig: PodConfig = {
    ...sampleConfig,
    sembleImage: "ghcr.io/kitten/semble-sidecar:latest",
    sembleIndexPvc: "kitten-semble-index",
  };

  it("no sembleImage → single container, no workspace volume, no sidecar env", () => {
    const pod = buildPodManifest(sampleJob, sampleConfig);
    expect(pod.spec?.containers).toHaveLength(1);
    const envMap = new Map((pod.spec?.containers[0]?.env ?? []).map((e) => [e.name, e.value]));
    expect(envMap.has("SEMBLE_SIDECAR_URL")).toBe(false);
  });

  it("sembleImage set → sidecar container sharing the workspace volume", () => {
    const pod = buildPodManifest(sampleJob, sidecarConfig);
    expect(pod.spec?.containers).toHaveLength(2);

    const sidecar = pod.spec?.containers.find((c) => c.name === "semble");
    expect(sidecar?.image).toBe("ghcr.io/kitten/semble-sidecar:latest");

    for (const container of pod.spec?.containers ?? []) {
      const mount = container.volumeMounts?.find((m) => m.name === "workspace");
      expect(mount?.mountPath).toBe("/workspace");
    }
    expect(pod.spec?.volumes?.find((v) => v.name === "workspace")?.emptyDir).toBeDefined();
  });

  it("reviewer gets CLONE_DIR and SEMBLE_SIDECAR_URL; sidecar gets the index path keyed by repo+base", () => {
    const pod = buildPodManifest(sampleJob, sidecarConfig);
    const reviewerEnv = new Map(
      (pod.spec?.containers.find((c) => c.name === "reviewer")?.env ?? []).map((e) => [e.name, e.value]),
    );
    expect(reviewerEnv.get("CLONE_DIR")).toBe("/workspace/repo");
    expect(reviewerEnv.get("SEMBLE_SIDECAR_URL")).toBe("http://127.0.0.1:8765");

    const sidecarEnv = new Map(
      (pod.spec?.containers.find((c) => c.name === "semble")?.env ?? []).map((e) => [e.name, e.value]),
    );
    expect(sidecarEnv.get("SEMBLE_CACHE_LOCATION")).toBe("/semble-index/octocat-hello-world/main~1");
    expect(sidecarEnv.get("REPO_PATH")).toBe("/workspace/repo");
  });

  it("reviewer references knowledge secrets including VOYAGE_BASE_URL (all optional)", () => {
    const pod = buildPodManifest(sampleJob, sampleConfig);
    const env = pod.spec?.containers[0]?.env ?? [];
    for (const name of ["MONGODB_URI", "VOYAGE_API_KEY", "VOYAGE_BASE_URL"]) {
      const entry = env.find((e) => e.name === name);
      expect(entry?.valueFrom?.secretKeyRef).toEqual({
        name: "kitten-knowledge-secrets",
        key: name,
        optional: true,
      });
    }
  });

  it("PVC configured → semble-index volume backed by the PVC", () => {
    const pod = buildPodManifest(sampleJob, sidecarConfig);
    const volume = pod.spec?.volumes?.find((v) => v.name === "semble-index");
    expect(volume?.persistentVolumeClaim?.claimName).toBe("kitten-semble-index");
    const sidecar = pod.spec?.containers.find((c) => c.name === "semble");
    expect(sidecar?.volumeMounts?.find((m) => m.name === "semble-index")?.mountPath).toBe("/semble-index");
  });

  it("no PVC → semble-index falls back to emptyDir (fresh index per run)", () => {
    const config: PodConfig = { ...sidecarConfig };
    delete (config as { sembleIndexPvc?: string }).sembleIndexPvc;
    const pod = buildPodManifest(sampleJob, config);
    const volume = pod.spec?.volumes?.find((v) => v.name === "semble-index");
    expect(volume?.persistentVolumeClaim).toBeUndefined();
    expect(volume?.emptyDir).toBeDefined();
  });
});

describe("buildPodManifest — scheduling (v10)", () => {
  const scheduledConfig: PodConfig = {
    ...sampleConfig,
    scheduling: {
      nodeSelector: { "workload-type": "kitten" },
      tolerations: [
        { key: "dedicated", operator: "Equal", value: "kitten", effect: "NoSchedule" },
      ],
      serviceAccountName: "kitten-reviewer",
    },
  };

  it("no scheduling → spec carries none of the three fields", () => {
    const pod = buildPodManifest(sampleJob, sampleConfig);
    expect("nodeSelector" in pod.spec!).toBe(false);
    expect("tolerations" in pod.spec!).toBe(false);
    expect("serviceAccountName" in pod.spec!).toBe(false);
  });

  it("scheduling set → each field present with the supplied values", () => {
    const pod = buildPodManifest(sampleJob, scheduledConfig);
    expect(pod.spec?.nodeSelector).toEqual({ "workload-type": "kitten" });
    expect(pod.spec?.tolerations).toEqual([
      { key: "dedicated", operator: "Equal", value: "kitten", effect: "NoSchedule" },
    ]);
    expect(pod.spec?.serviceAccountName).toBe("kitten-reviewer");
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
