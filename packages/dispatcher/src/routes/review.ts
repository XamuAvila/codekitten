import { Router } from "express";
import { ReviewJobSchema } from "@kitten/shared";
import type { ReviewJob } from "@kitten/shared";
import { validate } from "../middleware/validation.js";
import type { ReviewQueue } from "../queue/producer.js";

/**
 * POST /review — validates the payload and enqueues a review job.
 * Returns 202 with { jobId, status: "queued" } on success.
 */
export function createReviewRouter(queue: ReviewQueue): Router {
  const router = Router();

  router.post("/review", validate(ReviewJobSchema), async (req, res, next) => {
    try {
      const job: ReviewJob = req.body;
      const jobId = await queue.enqueue(job);
      res.status(202).json({ jobId, status: "queued" });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
