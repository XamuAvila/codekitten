import { Redis } from "ioredis";
import type { PubSubMessage } from "@kitten/shared";
import { subscribeToChannel } from "./redis/pubsub.js";
import { reportStatus, incrementFollowUpCount } from "./redis/status.js";
import { postFollowUpAck } from "./github/comment.js";

const DEFAULT_IDLE_TIMEOUT_MS = 600_000; // 10 minutes

export interface AgentConfig {
  readonly jobId: string;
  readonly redisUrl: string;
  readonly idleTimeoutMs?: number;
  readonly token?: string;
  readonly repo?: string;
  readonly prNumber?: number;
  /** Invoked when a follow-up message equals "force" (KIT-015). */
  readonly onForce?: () => Promise<void>;
  /** Invoked when a follow-up message equals "stop" (KIT-016). */
  readonly onStop?: () => Promise<void>;
}

/**
 * Start the agent lifecycle after the review pipeline completes.
 *
 * The agent:
 *   1. Reports status "reviewing"
 *   2. Subscribes to Redis channel `review:{jobId}:messages`
 *   3. Starts an idle timer (default 10min)
 *   4. On follow_up: resets idle timer, increments followUpCount
 *   5. On shutdown: reports "completed", cleans up, exits
 *   6. On idle timeout: same as shutdown
 *   7. On SIGTERM (K8s): same as shutdown
 */
export async function startAgent(config: AgentConfig): Promise<void> {
  const { jobId, redisUrl } = config;
  const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const channel = `review:${jobId}:messages`;

  // Separate connections: one for commands, one for subscriber mode
  const redis = new Redis(redisUrl);
  const subscriber = redis.duplicate();

  await reportStatus(redis, jobId, "reviewing");
  console.log(`[reviewer] Agent started for job ${jobId}, idle timeout ${idleTimeoutMs}ms`);

  // Resolve the returned promise when the agent shuts down
  let resolveAgent: () => void;
  const agentDone = new Promise<void>((resolve) => {
    resolveAgent = resolve;
  });

  let isShuttingDown = false;
  let idleTimer: ReturnType<typeof setTimeout>;

  async function shutdown(): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    clearTimeout(idleTimer);
    console.log(`[reviewer] Agent shutting down for job ${jobId}`);

    try {
      await reportStatus(redis, jobId, "completed");
      await subscription.unsubscribe();
      await redis.quit();
      await subscriber.quit();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[reviewer] Cleanup error: ${detail}`);
    }

    resolveAgent();
    process.exit(0);
  }

  function resetIdleTimer(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.log(`[reviewer] Idle timeout reached (${idleTimeoutMs}ms)`);
      void shutdown();
    }, idleTimeoutMs);
  }

  function handleMessage(msg: PubSubMessage): void {
    // Reset timer synchronously FIRST — prevents race with timeout firing mid-processing
    resetIdleTimer();

    if (msg.type === "follow_up") {
      const payload = msg.payload as { message: string; sender: string };
      console.log(`[reviewer] Follow-up received from ${payload.sender}: "${payload.message}"`);
      void incrementFollowUpCount(redis, jobId);

      const command = payload.message.trim().toLowerCase();
      if (command === "force") {
        if (config.onForce) void config.onForce();
        return;
      }
      if (command === "stop") {
        if (config.onStop) void config.onStop();
        return;
      }

      // Post ack comment on PR (non-fatal) — real LLM answer in KIT-017
      if (config.token && config.repo && config.prNumber) {
        void postFollowUpAck(config.token, config.repo, config.prNumber, payload.message);
      }
    } else if (msg.type === "shutdown") {
      console.log("[reviewer] Shutdown message received");
      void shutdown();
    }
  }

  const subscription = await subscribeToChannel(subscriber, channel, handleMessage);
  console.log(`[reviewer] Subscribed to ${channel}`);

  // Start idle timer
  resetIdleTimer();

  // SIGTERM handler for graceful K8s shutdown
  process.on("SIGTERM", () => {
    console.log("[reviewer] SIGTERM received");
    void shutdown();
  });

  return agentDone;
}
