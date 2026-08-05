import { Router } from "express";
import { AppError } from "@kitten/shared";

import { verifySignature } from "../webhook/signature.js";

/**
 * Result of routing a validated event: either an ignored marker or the
 * dispatch result to relay to GitHub (202).
 */
export interface RouteEventResult {
  readonly ignored?: boolean;
  readonly jobId?: string;
  readonly status?: string;
}

export interface WebhookDeps {
  /** Absent → the route answers 503 (a webhook accepting unsigned deliveries is worse than none). */
  readonly webhookSecret: string | undefined;
  /** Event router (KIT-032/033). Receives (X-GitHub-Event, parsed payload). */
  routeEvent(event: string, payload: unknown): Promise<RouteEventResult>;
}

/**
 * POST /webhook/github — signature-validated GitHub webhook entrypoint (v5).
 * Signature is checked over the EXACT raw bytes captured by the body parser
 * (`req.rawBody`, wired in server.ts) — never over re-serialized JSON.
 * The payload is only interpreted after the signature passes.
 */
export function createWebhookRouter(deps: WebhookDeps): Router {
  const router = Router();

  router.post("/webhook/github", async (req, res, next) => {
    try {
      if (!deps.webhookSecret) {
        throw new AppError("SERVICE_UNAVAILABLE", "WEBHOOK_SECRET is not configured");
      }

      const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
      const signature = req.header("X-Hub-Signature-256");
      if (!rawBody || !verifySignature(rawBody, signature, deps.webhookSecret)) {
        throw new AppError("AUTH_FAILED", "Invalid webhook signature");
      }

      const event = req.header("X-GitHub-Event") ?? "unknown";
      const delivery = req.header("X-GitHub-Delivery") ?? "unknown";
      console.log(`[dispatcher] Webhook delivery ${delivery}: event=${event}`);

      const result = await deps.routeEvent(event, req.body);
      if (result.ignored) {
        res.status(200).json({ ignored: true });
      } else {
        res.status(202).json(result);
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
