import { AppError } from "@kitten/shared";
import { runPipeline } from "./pipeline.js";
import { startAgent } from "./agent.js";
import { reportStatus } from "./redis/status.js";
import { Redis } from "ioredis";
import type { PipelineConfig } from "./types.js";

/**
 * Entrypoint for the reviewer container.
 * Reads env vars injected by the dispatcher, validates required fields,
 * runs the pipeline, then starts the agent lifecycle (KIT-008).
 * Pipeline success → agent starts (pub/sub listener for follow-ups).
 * Pipeline failure → reports "failed" status, exits with code 1.
 */
async function main(): Promise<void> {
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

  const result = await runPipeline(config);

  if (result.status === "failed") {
    console.error(`[reviewer] Review failed: ${result.error}`);
    // Report failed status to Redis before exiting
    try {
      const redis = new Redis(config.redisUrl);
      await reportStatus(redis, config.jobId, "failed");
      await redis.quit();
    } catch {
      console.warn("[reviewer] Failed to report status to Redis");
    }
    process.exit(1);
  }

  console.log(`[reviewer] Review completed, starting agent lifecycle`);

  const idleTimeoutMs = process.env["POD_IDLE_TIMEOUT_MS"]
    ? Number(process.env["POD_IDLE_TIMEOUT_MS"])
    : undefined;

  await startAgent({
    jobId: config.jobId,
    redisUrl: config.redisUrl,
    idleTimeoutMs,
  });
}

main().catch((error: unknown) => {
  if (error instanceof AppError) {
    console.error(`[reviewer] Fatal: [${error.code}] ${error.message}`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[reviewer] Fatal: ${message}`);
  }
  process.exit(1);
});
