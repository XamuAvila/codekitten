import express from "express";
import { Redis } from "ioredis";
import { createHealthRouter } from "./routes/health.js";
import { createReviewRouter } from "./routes/review.js";
import { createStatusRouter } from "./routes/status.js";
import { createMessageRouter } from "./routes/message.js";
import { createWebhookRouter } from "./routes/webhook.js";
import { routeEvent } from "./webhook/events.js";
import { errorHandler } from "./middleware/error-handler.js";
import { K8sClient } from "./k8s/client.js";
import type { PodConfig } from "./k8s/manifest.js";

export interface AppConfig {
  readonly redisUrl: string;
  readonly podConfig: PodConfig;
  /** GitHub webhook HMAC secret (v5). Absent → /webhook/github answers 503. */
  readonly webhookSecret?: string;
  /** Comment trigger word (v5). Default "@reviewer". */
  readonly triggerWord?: string;
}

export function createApp(config: AppConfig): express.Express {
  const app = express();
  const redis = new Redis(config.redisUrl, { lazyConnect: true });
  const k8sClient = new K8sClient();

  // Body parsing — rawBody kept for webhook HMAC (signature covers exact bytes)
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );

  // Routes
  app.use(createHealthRouter(redis));
  app.use(createReviewRouter({ k8sClient, redis, podConfig: config.podConfig }));
  app.use(createStatusRouter(redis));
  app.use(createMessageRouter(redis));
  app.use(
    createWebhookRouter({
      webhookSecret: config.webhookSecret,
      routeEvent: (event, payload) =>
        routeEvent(event, payload, {
          k8sClient,
          redis,
          podConfig: config.podConfig,
          triggerWord: config.triggerWord ?? "@reviewer",
        }),
    }),
  );

  // Global error handler (must be last)
  app.use(errorHandler);

  return app;
}
