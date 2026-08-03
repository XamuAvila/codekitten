import { Router } from "express";
import type { ReviewQueue } from "../queue/producer.js";
import { AppError } from "@kitten/shared";

/**
 * GET /status/:jobId — returns the current state of a review job.
 */
export function createStatusRouter(queue: ReviewQueue): Router {
  const router = Router();

  router.get("/status/:jobId", async (req, res, next) => {
    try {
      const { jobId } = req.params;

      if (!jobId || typeof jobId !== "string") {
        throw new AppError("VALIDATION", "Missing jobId parameter");
      }

      const status = await queue.getStatus(jobId);

      if (status.status === "not_found") {
        throw new AppError("NOT_FOUND", `Job ${jobId} not found`);
      }

      res.json({ id: jobId, ...status });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
