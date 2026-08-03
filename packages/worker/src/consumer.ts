import { Worker } from "bullmq";
import type { ReviewJob } from "@kitten/shared";
import { DEFAULT_CONFIG } from "@kitten/shared";
import { runPipeline } from "./pipeline.js";

/**
 * Starts a BullMQ Worker that listens for review jobs on the "reviews" queue.
 * Runs the full pipeline (clone → analyze dry-run → cleanup) for each job.
 */
export function startWorker(redisUrl: string): Worker<ReviewJob> {
  const worker = new Worker<ReviewJob>(
    "reviews",
    async (job) => {
      const workDir = `/tmp/clones/${job.id ?? `job-${Date.now()}`}`;
      return runPipeline(job.data, DEFAULT_CONFIG, workDir);
    },
    {
      connection: { url: redisUrl },
      concurrency: 1,
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 3600 },
    },
  );

  worker.on("ready", () => {
    console.log("[worker] Worker ready — listening for jobs on queue: reviews");
  });

  worker.on("error", (err) => {
    console.error("[worker] Worker error:", err);
  });

  return worker;
}
