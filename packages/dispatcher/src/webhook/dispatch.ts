import type { Redis } from "ioredis";
import { AppError } from "@kitten/shared";
import type { ReviewJob, ReviewJobStatus } from "@kitten/shared";

import type { K8sClient } from "../k8s/client.js";
import { buildPodManifest, buildPodName } from "../k8s/manifest.js";
import type { PodConfig } from "../k8s/manifest.js";

export interface DispatchDeps {
  readonly k8sClient: K8sClient;
  readonly redis: Redis;
  readonly podConfig: PodConfig;
}

export interface DispatchResult {
  readonly jobId: string;
  readonly status: "queued";
}

/**
 * Creates the reviewer Pod and stores the initial job status. Single
 * implementation shared by POST /review (routes/review.ts) and the GitHub
 * webhook (webhook/events.ts) — extracted in KIT-032 so the two entrypoints
 * cannot drift.
 */
export async function dispatchReview(job: ReviewJob, deps: DispatchDeps): Promise<DispatchResult> {
  const podName = buildPodName(job.repo, job.prNumber);
  const manifest = buildPodManifest(job, deps.podConfig);

  try {
    await deps.k8sClient.createPod(manifest);
  } catch (err) {
    throw new AppError("SERVICE_UNAVAILABLE", "Cannot create review pod", [
      { originalError: err instanceof Error ? err.message : String(err) },
    ]);
  }

  const initialStatus: ReviewJobStatus = {
    jobId: podName,
    status: "queued",
    podName,
    createdAt: new Date().toISOString(),
    followUpCount: 0,
  };
  await deps.redis.set(`review:${podName}:status`, JSON.stringify(initialStatus));

  return { jobId: podName, status: "queued" };
}
