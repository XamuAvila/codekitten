import { pathToFileURL } from "node:url";
import { AppError } from "@kitten/shared";
import { Redis } from "ioredis";
import { runPipeline } from "./pipeline.js";
import { startAgent } from "./agent.js";
import { reportStatus } from "./redis/status.js";
import { subscribeToChannel } from "./redis/pubsub.js";
import type { PipelineConfig } from "./types.js";

/**
 * Entrypoint for the reviewer container.
 * Reads env vars injected by the dispatcher, validates required fields,
 * reports "running", subscribes to the message channel BEFORE the pipeline
 * (KIT-016: a `stop` sent during chunks must reach the Pod — pub/sub is
 * fire-and-forget, so the subscription must be live before the pipeline
 * starts), runs the pipeline, then starts the agent lifecycle.
 *
 * Pipeline failure → reports "failed" status, exits with code 1.
 */
export async function main(): Promise<void> {
  const requiredEnvs = [
    "REVIEW_JOB_ID",
    "REVIEW_REPO",
    "REVIEW_PR_NUMBER",
    "REVIEW_HEAD_REF",
    "REVIEW_BASE_REF",
    "REVIEW_SENDER",
    "GITHUB_TOKEN",
    "REDIS_URL",
  ] as const;

  const missing = requiredEnvs.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`[reviewer] Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  const prNumber = Number(process.env["REVIEW_PR_NUMBER"]);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error("[reviewer] REVIEW_PR_NUMBER must be a positive integer");
    process.exit(1);
  }

  const config: PipelineConfig = {
    jobId: process.env["REVIEW_JOB_ID"]!,
    repo: process.env["REVIEW_REPO"]!,
    prNumber,
    headRef: process.env["REVIEW_HEAD_REF"]!,
    baseRef: process.env["REVIEW_BASE_REF"]!,
    token: process.env["GITHUB_TOKEN"]!,
    redisUrl: process.env["REDIS_URL"]!,
    skipPatterns: [],
  };

  console.log(`[reviewer] Starting review for ${config.repo} PR #${config.prNumber}`);

  // Separate connections: one for commands, one for subscriber mode
  const redis = new Redis(config.redisUrl);
  const subscriber = redis.duplicate();
  const channel = `review:${config.jobId}:messages`;

  // Shared abort controller — `stop` aborts the chunk loop (KIT-016)
  const controller = new AbortController();

  // Report "running" + subscribe BEFORE the pipeline so a `stop` sent
  // during chunks reaches this Pod (pub/sub is fire-and-forget).
  await reportStatus(redis, config.jobId, "running");
  const subscription = await subscribeToChannel(subscriber, channel, (msg) => {
    if (msg.type === "follow_up") {
      const payload = msg.payload as { message: string; sender: string };
      const command = payload.message.trim().toLowerCase();
      if (command === "stop") {
        console.log("[reviewer] stop received — aborting review");
        controller.abort();
      }
    }
  });
  console.log(`[reviewer] Subscribed to ${channel} (pre-pipeline)`);

  const result = await runPipeline(config, { signal: controller.signal });

  // Close the pre-pipeline subscriber — the agent opens its own
  await subscription.unsubscribe();
  await subscriber.quit();

  if (result.status === "failed") {
    console.error(`[reviewer] Review failed: ${result.error}`);
    try {
      await reportStatus(redis, config.jobId, "failed");
    } catch {
      console.warn("[reviewer] Failed to report status to Redis");
    }
    await redis.quit();
    process.exit(1);
  }

  console.log(`[reviewer] Review completed, starting agent lifecycle`);

  const idleTimeoutMs = process.env["POD_IDLE_TIMEOUT_MS"]
    ? Number(process.env["POD_IDLE_TIMEOUT_MS"])
    : undefined;

  // `force` re-runs the full review without the token budget (KIT-015)
  const onForce = async (): Promise<void> => {
    console.log("[reviewer] force received — re-running full review without budget");
    try {
      await runPipeline(config, { ignoreBudget: true, signal: controller.signal });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[reviewer] Forced review failed: ${message}`);
    }
  };

  // `stop` on a completed pipeline → clean shutdown with cancelled status (KIT-016)
  const onStop = async (): Promise<void> => {
    console.log("[reviewer] stop received — shutting down");
    try {
      await reportStatus(redis, config.jobId, "cancelled");
      await postReviewComment(config.token, config.repo, config.prNumber, "Review cancelled");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[reviewer] Stop cleanup error: ${message}`);
    }
    await redis.quit();
    process.exit(0);
  };

  await startAgent({
    jobId: config.jobId,
    redisUrl: config.redisUrl,
    idleTimeoutMs,
    token: config.token,
    repo: config.repo,
    prNumber: config.prNumber,
    onForce,
    onStop,
    // KIT-017: follow-up answers reuse the review's config + context
    llmConfig: result.llmConfig,
    reviewContext: result.findings
      ? {
          findings: result.findings,
          prompt: result.prompt ?? { system: "", user: "" },
        }
      : undefined,
  });
}

/** Posts a plain cancellation notice comment (non-fatal). */
async function postReviewComment(
  token: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  const { Octokit } = await import("@octokit/rest");
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) return;
  try {
    const octokit = new Octokit({ auth: token });
    await octokit.issues.createComment({
      owner,
      repo: repoName,
      issue_number: prNumber,
      body: `🐱 **Kitten** [KITTEN-TEST]\n\n${body}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[reviewer] Failed to post cancellation comment: ${message}`);
  }
}

// Auto-run only when executed directly (not when imported by tests)
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    if (error instanceof AppError) {
      console.error(`[reviewer] Fatal: [${error.code}] ${error.message}`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[reviewer] Fatal: ${message}`);
    }
    process.exit(1);
  });
}
