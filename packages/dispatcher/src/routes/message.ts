import { Router } from "express";
import type { Redis } from "ioredis";
import { FollowUpMessageSchema, AppError } from "@kitten/shared";
import type { ReviewJobStatus, PubSubMessage } from "@kitten/shared";
import { validate } from "../middleware/validation.js";

/** Terminal statuses — a follow-up to a completed/failed job is rejected. */
const TERMINAL_STATUSES = new Set(["completed", "failed"]);

/**
 * POST /review/:jobId/message — publishes a follow-up message to the
 * reviewer Pod via Redis pub/sub.
 *
 * The message is fire-and-forget: published to channel `review:{jobId}:messages`.
 * If the Pod is dead the message is lost — that is by design (card KIT-006).
 *
 * Returns 200 { status: "sent" } on success, 404 if job not active.
 */
export function createMessageRouter(redis: Redis): Router {
  const router = Router();

  router.post(
    "/review/:jobId/message",
    validate(FollowUpMessageSchema),
    async (req, res, next) => {
      try {
        const { jobId } = req.params;

        if (!jobId || typeof jobId !== "string") {
          throw new AppError("VALIDATION", "Missing jobId parameter");
        }

        const raw = await redis.get(`review:${jobId}:status`);

        if (!raw) {
          throw new AppError("NOT_FOUND", `Job ${jobId} not found`);
        }

        const status: ReviewJobStatus = JSON.parse(raw);

        if (TERMINAL_STATUSES.has(status.status)) {
          throw new AppError("NOT_FOUND", `Job ${jobId} is no longer active`);
        }

        const pubSubMessage: PubSubMessage = {
          type: "follow_up",
          payload: req.body,
          timestamp: new Date().toISOString(),
        };

        await redis.publish(
          `review:${jobId}:messages`,
          JSON.stringify(pubSubMessage),
        );

        // followUpCount is incremented by the Pod when it actually receives
        // the message — the dispatcher publishes fire-and-forget and cannot
        // know whether a live Pod consumed it.

        res.json({ status: "sent" });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
