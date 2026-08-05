import crypto from "node:crypto";

/**
 * Verifies a GitHub `X-Hub-Signature-256` header against the raw request
 * body. HMAC SHA-256 with timing-safe comparison — an explicit length check
 * first, because `timingSafeEqual` throws on length mismatch.
 *
 * The secret and the signature are never logged by this module.
 */
export function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = signatureHeader.slice("sha256=".length);

  if (received.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(received, "utf-8"), Buffer.from(expected, "utf-8"));
}
