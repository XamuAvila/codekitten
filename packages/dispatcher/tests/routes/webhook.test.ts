import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import crypto from "node:crypto";

import { createWebhookRouter } from "../../src/routes/webhook.js";
import { errorHandler } from "../../src/middleware/error-handler.js";
import type { WebhookDeps } from "../../src/routes/webhook.js";

const SECRET = "test-webhook-secret";

function sign(body: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

function buildApp(deps: Partial<WebhookDeps>) {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(
    createWebhookRouter({
      webhookSecret: SECRET,
      routeEvent: vi.fn().mockResolvedValue({ ignored: true }),
      ...deps,
    } as WebhookDeps),
  );
  app.use(errorHandler);
  return app;
}

describe("POST /webhook/github", () => {
  let routeEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    routeEvent = vi.fn().mockResolvedValue({ ignored: true });
  });

  it("valid signature + unknown event → 200 ignored", async () => {
    const app = buildApp({ routeEvent });
    const body = JSON.stringify({ action: "created" });

    const res = await request(app)
      .post("/webhook/github")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "star")
      .set("X-GitHub-Delivery", "delivery-1")
      .set("X-Hub-Signature-256", sign(body, SECRET))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ignored: true });
    expect(routeEvent).toHaveBeenCalledWith("star", { action: "created" });
  });

  it("bad signature → 401 AUTH_FAILED, event never routed", async () => {
    const app = buildApp({ routeEvent });
    const body = JSON.stringify({ action: "opened" });

    const res = await request(app)
      .post("/webhook/github")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", sign(body, "wrong-secret"))
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("AUTH_FAILED");
    expect(routeEvent).not.toHaveBeenCalled();
  });

  it("missing signature → 401", async () => {
    const app = buildApp({ routeEvent });

    const res = await request(app)
      .post("/webhook/github")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "pull_request")
      .send(JSON.stringify({ action: "opened" }));

    expect(res.status).toBe(401);
    expect(routeEvent).not.toHaveBeenCalled();
  });

  it("no WEBHOOK_SECRET configured → 503 SERVICE_UNAVAILABLE", async () => {
    const app = buildApp({ routeEvent, webhookSecret: undefined });
    const body = JSON.stringify({ action: "opened" });

    const res = await request(app)
      .post("/webhook/github")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", sign(body, SECRET))
      .send(body);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("SERVICE_UNAVAILABLE");
    expect(routeEvent).not.toHaveBeenCalled();
  });

  it("routeEvent result is returned (dispatched case)", async () => {
    routeEvent.mockResolvedValue({ jobId: "review-x-1", status: "queued" });
    const app = buildApp({ routeEvent });
    const body = JSON.stringify({ action: "opened" });

    const res = await request(app)
      .post("/webhook/github")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", sign(body, SECRET))
      .send(body);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ jobId: "review-x-1", status: "queued" });
  });
});
