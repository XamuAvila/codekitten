import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Redis } from "ioredis";

/** Minimal shape the subscriber needs — subscribe/unsubscribe/on/quit. */
type MockSubscriber = Pick<Redis, "subscribe" | "unsubscribe" | "on" | "quit">;

// --- Mock ioredis ---
const mockSubscribe = vi.fn().mockResolvedValue(undefined);
const mockUnsubscribe = vi.fn().mockResolvedValue(undefined);
const mockOn = vi.fn();
const mockQuit = vi.fn().mockResolvedValue(undefined);

vi.mock("ioredis", () => ({
  Redis: class MockRedis {
    subscribe = mockSubscribe;
    unsubscribe = mockUnsubscribe;
    on = mockOn;
    quit = mockQuit;
    duplicate = vi.fn(() => new (this.constructor as new () => MockRedis)());
  },
}));

import { parsePubSubMessage, subscribeToChannel } from "../../src/redis/pubsub.js";

describe("parsePubSubMessage", () => {
  it("parses valid follow_up message", () => {
    const raw = JSON.stringify({
      type: "follow_up",
      payload: { message: "explain this function", sender: "alice" },
      timestamp: "2026-08-03T00:00:00Z",
    });

    const result = parsePubSubMessage(raw);

    expect(result.type).toBe("follow_up");
    expect(result.payload).toEqual({ message: "explain this function", sender: "alice" });
    expect(result.timestamp).toBe("2026-08-03T00:00:00Z");
  });

  it("parses valid shutdown message", () => {
    const raw = JSON.stringify({
      type: "shutdown",
      payload: {},
      timestamp: "2026-08-03T01:00:00Z",
    });

    const result = parsePubSubMessage(raw);

    expect(result.type).toBe("shutdown");
    expect(result.payload).toEqual({});
    expect(result.timestamp).toBe("2026-08-03T01:00:00Z");
  });

  it("throws on invalid JSON", () => {
    expect(() => parsePubSubMessage("not json")).toThrow();
  });

  it("throws on missing type field", () => {
    const raw = JSON.stringify({ payload: {}, timestamp: "2026-08-03T00:00:00Z" });

    expect(() => parsePubSubMessage(raw)).toThrow();
  });

  it("throws on unknown message type", () => {
    const raw = JSON.stringify({
      type: "unknown",
      payload: {},
      timestamp: "2026-08-03T00:00:00Z",
    });

    expect(() => parsePubSubMessage(raw)).toThrow();
  });

  it("throws when follow_up payload missing required fields", () => {
    const raw = JSON.stringify({
      type: "follow_up",
      payload: { message: "hi" }, // missing sender
      timestamp: "2026-08-03T00:00:00Z",
    });

    expect(() => parsePubSubMessage(raw)).toThrow();
  });
});

describe("subscribeToChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("subscribes to the specified channel", async () => {
    const handler = vi.fn();
    const mockSubscriber = {
      subscribe: mockSubscribe,
      unsubscribe: mockUnsubscribe,
      on: mockOn,
      quit: mockQuit,
    };

    await subscribeToChannel(mockSubscriber as MockSubscriber, "review:job-1:messages", handler);

    expect(mockSubscribe).toHaveBeenCalledWith("review:job-1:messages");
  });

  it("wires message handler that filters by channel", async () => {
    const handler = vi.fn();
    let capturedMessageHandler: ((channel: string, message: string) => void) | undefined;

    mockOn.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === "message") {
        capturedMessageHandler = cb as (channel: string, message: string) => void;
      }
    });

    const mockSubscriber = {
      subscribe: mockSubscribe,
      unsubscribe: mockUnsubscribe,
      on: mockOn,
      quit: mockQuit,
    };

    await subscribeToChannel(mockSubscriber as MockSubscriber, "review:job-1:messages", handler);

    expect(capturedMessageHandler).toBeDefined();

    // Message on correct channel → handler called
    const validMessage = JSON.stringify({
      type: "follow_up",
      payload: { message: "hi", sender: "bob" },
      timestamp: "2026-08-03T00:00:00Z",
    });
    capturedMessageHandler!("review:job-1:messages", validMessage);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: "follow_up" }));

    // Message on different channel → handler NOT called
    capturedMessageHandler!("review:other:messages", validMessage);
    expect(handler).toHaveBeenCalledTimes(1); // still 1
  });

  it("returns unsubscribe function", async () => {
    const handler = vi.fn();
    const mockSubscriber = {
      subscribe: mockSubscribe,
      unsubscribe: mockUnsubscribe,
      on: mockOn,
      quit: mockQuit,
    };

    const sub = await subscribeToChannel(mockSubscriber as MockSubscriber, "review:job-1:messages", handler);

    expect(sub.unsubscribe).toBeDefined();
    await sub.unsubscribe();
    expect(mockUnsubscribe).toHaveBeenCalledWith("review:job-1:messages");
  });
});
