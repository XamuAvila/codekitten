import { Redis } from "ioredis";
import { startWorker } from "./consumer.js";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

async function main(): Promise<void> {
  const redis = new Redis(redisUrl, { lazyConnect: true });

  try {
    await redis.connect();
    console.log("[worker] Connected to Redis");
  } catch {
    console.error("[worker] Redis connection failed");
    process.exit(1);
  }

  console.log("[worker] Listening for jobs on queue: reviews");

  // Start the BullMQ worker — consumes review jobs, runs pipeline
  const worker = startWorker(redisUrl);

  const shutdown = async () => {
    console.log("[worker] Shutting down...");
    await worker.close();
    await redis.quit();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error: unknown) => {
  console.error("[worker] Fatal start error:", error);
  process.exit(1);
});
