import express from "express";
import { Redis } from "ioredis";
import { createHealthRouter } from "./routes/health.js";
import { createReviewRouter } from "./routes/review.js";
import { createStatusRouter } from "./routes/status.js";
import { errorHandler } from "./middleware/error-handler.js";
import { ReviewQueue } from "./queue/producer.js";

export function createApp(redisUrl: string): express.Express {
  const app = express();
  const redis = new Redis(redisUrl, { lazyConnect: true });
  const queue = new ReviewQueue(redisUrl);

  // Body parsing
  app.use(express.json());

  // Routes
  app.use(createHealthRouter(redis));
  app.use(createReviewRouter(queue));
  app.use(createStatusRouter(queue));

  // Global error handler (must be last)
  app.use(errorHandler);

  return app;
}
