import { Router } from "express";
import type { Redis } from "ioredis";
import { ReviewJobSchema } from "@kitten/shared";
import type { ReviewJob } from "@kitten/shared";
import { validate } from "../middleware/validation.js";
import type { K8sClient } from "../k8s/client.js";
import type { PodConfig } from "../k8s/manifest.js";
import { dispatchReview } from "../webhook/dispatch.js";

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
      // Pod creation + status write shared with the webhook (KIT-032)
      const result = await dispatchReview(job, deps);
      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
