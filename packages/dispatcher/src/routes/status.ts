import { Router } from "express";
import type { Redis } from "ioredis";
import { AppError } from "@kitten/shared";

/**
 * GET /status/:jobId — returns the current state of a review job from Redis.
 */
export function createStatusRouter(redis: Redis): Router {
  const router = Router();

  router.get("/status/:jobId", async (req, res, next) => {
    try {
      const { jobId } = req.params;

      if (!jobId || typeof jobId !== "string") {
        throw new AppError("VALIDATION", "Missing jobId parameter");
      }

      const raw = await redis.get(`review:${jobId}:status`);

      if (raw === null) {
        throw new AppError("NOT_FOUND", `Job ${jobId} not found`);
      }

      const status = JSON.parse(raw);
      res.json(status);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
