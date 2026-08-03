import { AppError } from "@kitten/shared";
import { runPipeline } from "./pipeline.js";
import type { PipelineConfig } from "./types.js";

/**
 * Entrypoint for the reviewer container.
 * Reads env vars injected by the dispatcher, validates required fields,
 * runs the pipeline, and exits.
 * Agent handoff (KIT-008) will be added here later.
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
    process.exit(1);
  }

  console.log(`[reviewer] Review completed successfully`);
  // KIT-008: agent handoff will go here
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
