import type { Redis } from "ioredis";
import type { PubSubMessage, ReviewJobStatus } from "@kitten/shared";

/** Terminal statuses — messages to completed/failed/cancelled jobs are rejected. */
export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Active-job check + follow_up publish, shared by POST /review/:jobId/message
 * (routes/message.ts) and the webhook comment router (webhook/events.ts) so
 * the two entrypoints cannot drift (KIT-033 decision 1).
 *
 * Returns false when the job is unknown or terminal — the caller decides
 * whether that is a 404 (HTTP route) or an ignored delivery (webhook).
 */
export async function publishFollowUp(
  redis: Redis,
  jobId: string,
  message: string,
  sender: string,
): Promise<boolean> {
  const raw = await redis.get(`review:${jobId}:status`);
  if (!raw) return false;

  try {
    const status = JSON.parse(raw) as ReviewJobStatus;
    if (TERMINAL_STATUSES.has(status.status)) return false;
  } catch {
    return false;
  }

  const pubSubMessage: PubSubMessage = {
    type: "follow_up",
    payload: { message, sender },
    timestamp: new Date().toISOString(),
  };
  await redis.publish(`review:${jobId}:messages`, JSON.stringify(pubSubMessage));
  return true;
}
