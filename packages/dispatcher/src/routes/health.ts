import { Router } from "express";
import type { Redis } from "ioredis";

export function createHealthRouter(redis: Redis): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    try {
      const pong = await redis.ping();
      const redisStatus = pong === "PONG" ? "connected" : "disconnected";
      res.json({ status: "ok", redis: redisStatus });
    } catch {
      res.json({ status: "ok", redis: "disconnected" });
    }
  });

  return router;
}
