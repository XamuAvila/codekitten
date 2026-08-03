import type { Redis } from "ioredis";
import { PubSubMessageSchema } from "@kitten/shared";
import type { PubSubMessage } from "@kitten/shared";
import { AppError } from "@kitten/shared";

/**
 * Parse and validate a raw Redis pub/sub message string into a typed PubSubMessage.
 * Throws AppError(VALIDATION) on invalid JSON or schema mismatch.
 */
export function parsePubSubMessage(raw: string): PubSubMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError("VALIDATION", `Invalid JSON in pub/sub message: ${raw.slice(0, 100)}`);
  }

  const result = PubSubMessageSchema.safeParse(parsed);
  if (!result.success) {
    throw new AppError("VALIDATION", `Invalid pub/sub message: ${result.error.message}`);
  }

  return result.data;
}

interface Subscription {
  readonly unsubscribe: () => Promise<void>;
}

/**
 * Subscribe to a Redis channel and invoke handler for each valid message.
 * Uses a separate Redis connection in subscriber mode (ioredis requirement).
 * Invalid messages are logged and skipped — they do NOT crash the subscriber.
 */
export async function subscribeToChannel(
  subscriber: Redis,
  channel: string,
  handler: (msg: PubSubMessage) => void,
): Promise<Subscription> {
  subscriber.on("message", (msgChannel: string, message: string) => {
    if (msgChannel !== channel) return;

    try {
      const parsed = parsePubSubMessage(message);
      handler(parsed);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[reviewer] Invalid pub/sub message on ${channel}: ${detail}`);
    }
  });

  await subscriber.subscribe(channel);

  return {
    unsubscribe: async () => {
      await subscriber.unsubscribe(channel);
    },
  };
}
