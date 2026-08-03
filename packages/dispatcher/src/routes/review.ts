import { Router } from "express";
import type { Redis } from "ioredis";
import { ReviewJobSchema, AppError } from "@kitten/shared";
import type { ReviewJob, ReviewJobStatus } from "@kitten/shared";
import { validate } from "../middleware/validation.js";
import type { K8sClient } from "../k8s/client.js";
import { buildPodManifest, buildPodName } from "../k8s/manifest.js";
import type { PodConfig } from "../k8s/manifest.js";

export interface ReviewRouterDeps {
  readonly k8sClient: K8sClient;
  readonly redis: Redis;
  readonly podConfig: PodConfig;
}

/**
 * POST /review — validates the payload, creates a K8s Pod for the review,
 * stores initial status in Redis, and returns 202 with { jobId, status }.
 */
export function createReviewRouter(deps: ReviewRouterDeps): Router {
  const router = Router();

  router.post("/review", validate(ReviewJobSchema), async (req, res, next) => {
    try {
      const job: ReviewJob = req.body;
      const podName = buildPodName(job.repo, job.prNumber);
      const manifest = buildPodManifest(job, deps.podConfig);

      try {
        await deps.k8sClient.createPod(manifest);
      } catch (err) {
        throw new AppError(
          "SERVICE_UNAVAILABLE",
          "Cannot create review pod",
          [{ originalError: err instanceof Error ? err.message : String(err) }],
        );
      }

      const initialStatus: ReviewJobStatus = {
        jobId: podName,
        status: "queued",
        podName,
        createdAt: new Date().toISOString(),
        followUpCount: 0,
      };

      await deps.redis.set(
        `review:${podName}:status`,
        JSON.stringify(initialStatus),
      );

      res.status(202).json({ jobId: podName, status: "queued" });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
