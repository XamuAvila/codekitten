import { describe, expect, it } from "vitest";
import crypto from "node:crypto";

import { verifySignature } from "../src/webhook/signature.js";

const SECRET = "test-webhook-secret";

function sign(body: Buffer, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifySignature", () => {
  const body = Buffer.from(JSON.stringify({ action: "opened" }));

  it("accepts a valid signature", () => {
    expect(verifySignature(body, sign(body, SECRET), SECRET)).toBe(true);
  });

  it("rejects a signature made with another secret", () => {
    expect(verifySignature(body, sign(body, "wrong"), SECRET)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const tampered = Buffer.from(JSON.stringify({ action: "evil" }));
    expect(verifySignature(tampered, sign(body, SECRET), SECRET)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
  });

  it("rejects a malformed header (wrong prefix or length)", () => {
    expect(verifySignature(body, "sha1=abc", SECRET)).toBe(false);
    expect(verifySignature(body, "sha256=deadbeef", SECRET)).toBe(false);
    expect(verifySignature(body, "garbage", SECRET)).toBe(false);
  });
});
