import { Router } from "express";
import type { Redis } from "ioredis";
import { FollowUpMessageSchema, AppError } from "@kitten/shared";
import { validate } from "../middleware/validation.js";
import { publishFollowUp } from "../webhook/follow-up.js";

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

        // Active-check + publish shared with the webhook (webhook/follow-up.ts).
        // followUpCount is incremented by the Pod when it actually receives
        // the message — publish is fire-and-forget.
        const sent = await publishFollowUp(redis, jobId, req.body.message, req.body.sender);
        if (!sent) {
          throw new AppError("NOT_FOUND", `Job ${jobId} not found or no longer active`);
        }

        res.json({ status: "sent" });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
