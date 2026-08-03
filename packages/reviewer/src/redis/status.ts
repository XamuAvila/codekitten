import type { Redis } from "ioredis";
import type { ReviewJobStatus } from "@kitten/shared";

/**
 * Redis key pattern for review job status hashes.
 */
function statusKey(jobId: string): string {
  return `review:${jobId}:status`;
}

/** Terminal statuses that require setting completedAt. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed"]);

/**
 * Update the status field of a review job in Redis.
 * For terminal statuses (completed, failed), also sets completedAt to current ISO timestamp.
 */
export async function reportStatus(
  redis: Redis,
  jobId: string,
  status: ReviewJobStatus["status"],
): Promise<void> {
  const key = statusKey(jobId);
  await redis.hset(key, "status", status);

  if (TERMINAL_STATUSES.has(status)) {
    await redis.hset(key, "completedAt", new Date().toISOString());
  }
}

/**
 * Atomically increment the followUpCount field for a review job.
 * Returns the new count after increment.
 */
export async function incrementFollowUpCount(
  redis: Redis,
  jobId: string,
): Promise<number> {
  return redis.hincrby(statusKey(jobId), "followUpCount", 1);
}

/**
 * Fetch the full status hash for a review job.
 * Returns null if the key does not exist (empty hash from HGETALL).
 */
export async function getStatus(
  redis: Redis,
  jobId: string,
): Promise<ReviewJobStatus | null> {
  const data = await redis.hgetall(statusKey(jobId));

  // ioredis HGETALL returns {} for missing keys
  if (!data || Object.keys(data).length === 0) {
    return null;
  }

  return {
    jobId: data["jobId"] ?? jobId,
    status: data["status"] as ReviewJobStatus["status"],
    podName: data["podName"] ?? "",
    createdAt: data["createdAt"] ?? "",
    completedAt: data["completedAt"],
    durationMs: data["durationMs"] ? Number(data["durationMs"]) : undefined,
    followUpCount: Number(data["followUpCount"] ?? 0),
  };
}
