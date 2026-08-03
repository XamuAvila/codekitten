import type { Redis } from "ioredis";
import type { ReviewJobStatus } from "@kitten/shared";

/**
 * Redis key pattern for review job status.
 * Stored as JSON string (same format as dispatcher).
 */
function statusKey(jobId: string): string {
  return `review:${jobId}:status`;
}

/** Terminal statuses that require setting completedAt. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/**
 * Update the status of a review job in Redis.
 * Reads current status, merges the new status field, writes back.
 * For terminal statuses, also sets completedAt.
 */
export async function reportStatus(
  redis: Redis,
  jobId: string,
  status: ReviewJobStatus["status"],
): Promise<void> {
  const key = statusKey(jobId);
  const raw = await redis.get(key);
  const current: Partial<ReviewJobStatus> = raw ? JSON.parse(raw) : { jobId, podName: jobId, createdAt: new Date().toISOString(), followUpCount: 0 };

  const updated = {
    ...current,
    status,
    ...(TERMINAL_STATUSES.has(status) ? { completedAt: new Date().toISOString() } : {}),
  };

  await redis.set(key, JSON.stringify(updated));
}

/**
 * Increment the followUpCount for a review job.
 * Reads current status, increments, writes back.
 */
export async function incrementFollowUpCount(
  redis: Redis,
  jobId: string,
): Promise<number> {
  const key = statusKey(jobId);
  const raw = await redis.get(key);

  if (!raw) return 0;

  const current: ReviewJobStatus = JSON.parse(raw);
  const newCount = current.followUpCount + 1;
  const updated = { ...current, followUpCount: newCount };
  await redis.set(key, JSON.stringify(updated));

  return newCount;
}

/**
 * Fetch the full status for a review job.
 * Returns null if the key does not exist.
 */
export async function getStatus(
  redis: Redis,
  jobId: string,
): Promise<ReviewJobStatus | null> {
  const raw = await redis.get(statusKey(jobId));
  if (!raw) return null;
  return JSON.parse(raw);
}
