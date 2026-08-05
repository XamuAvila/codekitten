import express from "express";
import { Redis } from "ioredis";
import { createKnowledgeClient } from "@kitten/shared";
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
  // Knowledge store (KIT-037) — undefined without secrets; remember/correction
  // capture degrade with a warning, reviews unaffected (epic error table).
  const knowledgeClient = createKnowledgeClient(process.env);
  if (knowledgeClient === undefined) {
    console.warn("[dispatcher] Knowledge store disabled — MONGODB_URI/VOYAGE_API_KEY not set");
  }

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
          ...(knowledgeClient !== undefined ? { knowledgeClient } : {}),
          getReviewComment: fetchReviewComment,
        }),
    }),
  );

  // Global error handler (must be last)
  app.use(errorHandler);

  return app;
}

/**
 * GET /repos/{repo}/pulls/comments/{id} — root-comment lookup for correction
 * capture (KIT-038). 404 → undefined (thread root deleted); other failures
 * throw and are contained by the caller.
 */
async function fetchReviewComment(
  repo: string,
  commentId: number,
): Promise<{ body: string; user: { login: string; type?: string } } | undefined> {
  const token = process.env.GITHUB_TOKEN;
  const response = await fetch(`https://api.github.com/repos/${repo}/pulls/comments/${commentId}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`GitHub review-comment lookup failed: HTTP ${response.status}`);
  }
  const data = (await response.json()) as { body?: string; user?: { login?: string; type?: string } };
  return {
    body: data.body ?? "",
    user: { login: data.user?.login ?? "unknown", ...(data.user?.type ? { type: data.user.type } : {}) },
  };
}
