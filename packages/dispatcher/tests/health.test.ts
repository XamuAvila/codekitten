import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import { createHealthRouter } from "../src/routes/health.js";

function buildApp(redisStatus: "connected" | "disconnected") {
  const app = express();
  const redis = {
    ping: async () => {
      if (redisStatus === "connected") {
        return "PONG";
      }
      throw new Error("Redis unreachable");
    },
  } as unknown as import("ioredis").Redis;
  app.use(createHealthRouter(redis));
  return app;
}

describe("GET /health", () => {
  it("returns ok with redis connected when Redis is reachable", async () => {
    const res = await request(buildApp("connected")).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", redis: "connected" });
  });

  it("returns ok with redis disconnected when Redis is unreachable", async () => {
    const res = await request(buildApp("disconnected")).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", redis: "disconnected" });
  });
});
