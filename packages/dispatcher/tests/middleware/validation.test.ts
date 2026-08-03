import { describe, it, expect } from "vitest";
import { z } from "zod";
import request from "supertest";
import express from "express";
import { validate } from "../../src/middleware/validation.js";
import { errorHandler } from "../../src/middleware/error-handler.js";

const TestSchema = z.object({
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post("/test", validate(TestSchema), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

describe("validate middleware", () => {
  it("passes through when payload is valid", async () => {
    const res = await request(buildApp())
      .post("/test")
      .send({ repo: "org/repo", prNumber: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns 400 VALIDATION when required field is missing", async () => {
    const res = await request(buildApp())
      .post("/test")
      .send({ prNumber: 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
    expect(res.body.message).toBe("Invalid payload");
    expect(res.body.details).toBeInstanceOf(Array);
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it("strips extra fields not in schema", async () => {
    const res = await request(buildApp())
      .post("/test")
      .send({ repo: "org/repo", prNumber: 1, extra: "should-be-stripped" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns 400 when body is not JSON", async () => {
    const res = await request(buildApp())
      .post("/test")
      .set("Content-Type", "application/json")
      .send("not json");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });
});
