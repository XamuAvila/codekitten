import express from "express";
import { Redis } from "ioredis";
import { createHealthRouter } from "./routes/health.js";

export function createApp(redisUrl: string): express.Express {
  const app = express();
  const redis = new Redis(redisUrl, { lazyConnect: true });

  app.use(createHealthRouter(redis));

  return app;
}
