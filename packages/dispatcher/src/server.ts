import express from "express";
import { Redis } from "ioredis";
import { createHealthRouter } from "./routes/health.js";
import { createReviewRouter } from "./routes/review.js";
import { createStatusRouter } from "./routes/status.js";
import { createMessageRouter } from "./routes/message.js";
import { errorHandler } from "./middleware/error-handler.js";
import { K8sClient } from "./k8s/client.js";
import type { PodConfig } from "./k8s/manifest.js";

export interface AppConfig {
  readonly redisUrl: string;
  readonly podConfig: PodConfig;
}

export function createApp(config: AppConfig): express.Express {
  const app = express();
  const redis = new Redis(config.redisUrl, { lazyConnect: true });
  const k8sClient = new K8sClient();

  // Body parsing
  app.use(express.json());

  // Routes
  app.use(createHealthRouter(redis));
  app.use(createReviewRouter({ k8sClient, redis, podConfig: config.podConfig }));
  app.use(createStatusRouter(redis));
  app.use(createMessageRouter(redis));

  // Global error handler (must be last)
  app.use(errorHandler);

  return app;
}
