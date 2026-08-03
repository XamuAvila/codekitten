import { z } from "zod";

/**
 * ReviewJobStatus — stored in Redis at `review:{jobId}:status`.
 * Tracks the lifecycle of a review Pod from creation to completion.
 */
export const ReviewJobStatusSchema = z.object({
  jobId: z.string().min(1),
  status: z.enum(["queued", "running", "reviewing", "completed", "failed", "cancelled"]),
  podName: z.string().min(1),
  createdAt: z.string().min(1),
  completedAt: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  followUpCount: z.number().int().nonnegative(),
});

export type ReviewJobStatus = z.infer<typeof ReviewJobStatusSchema>;

/**
 * FollowUpMessage — body of POST /review/:jobId/message.
 */
export const FollowUpMessageSchema = z.object({
  message: z.string().min(1),
  sender: z.string().min(1),
});

export type FollowUpMessage = z.infer<typeof FollowUpMessageSchema>;

/**
 * PubSubMessage — published to Redis channel `review:{jobId}:messages`.
 * The reviewer Pod subscribes to this channel for follow-up instructions.
 */
export const PubSubMessageSchema = z.object({
  type: z.enum(["follow_up", "shutdown"]),
  payload: z.union([FollowUpMessageSchema, z.record(z.string(), z.never())]),
  timestamp: z.string().min(1),
});

export type PubSubMessage = z.infer<typeof PubSubMessageSchema>;
