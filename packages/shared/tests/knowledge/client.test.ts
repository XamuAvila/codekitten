import { describe, expect, it, vi } from "vitest";

import { createKnowledgeClient } from "../../src/knowledge/client.js";
import type { KnowledgeDeps } from "../../src/knowledge/client.js";

const ENV = { MONGODB_URI: "mongodb+srv://cluster.test/kitten", VOYAGE_API_KEY: "voyage-key" };
const EMBEDDING = Array.from({ length: 1024 }, (_, i) => i / 1024);

function makeDeps(): KnowledgeDeps & {
  insertOne: ReturnType<typeof vi.fn>;
  aggregate: ReturnType<typeof vi.fn>;
  fetchFn: ReturnType<typeof vi.fn>;
} {
  const insertOne = vi.fn().mockResolvedValue({ insertedId: "id" });
  const aggregate = vi.fn().mockReturnValue({
    toArray: vi.fn().mockResolvedValue([
      { text: "we always use X for Y", source: "command", author: "alice", score: 0.91 },
    ]),
  });
  const fetchFn = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ embedding: EMBEDDING }] }),
  });
  const collection = { insertOne, aggregate };
  const connect = vi.fn().mockResolvedValue({
    db: () => ({ collection: () => collection }),
    close: vi.fn(),
  });
  return { connect, fetchFn, insertOne, aggregate } as never;
}

describe("createKnowledgeClient", () => {
  it("returns undefined when MONGODB_URI or VOYAGE_API_KEY missing", () => {
    expect(createKnowledgeClient({}, makeDeps())).toBeUndefined();
    expect(createKnowledgeClient({ MONGODB_URI: ENV.MONGODB_URI }, makeDeps())).toBeUndefined();
    expect(createKnowledgeClient({ VOYAGE_API_KEY: ENV.VOYAGE_API_KEY }, makeDeps())).toBeUndefined();
  });

  it("insert embeds via Voyage (document input_type) and writes the shaped doc", async () => {
    const deps = makeDeps();
    const client = createKnowledgeClient(ENV, deps)!;

    await client.insert({ repo: "org/repo", text: "always use X", source: "command", author: "alice", prNumber: 7 });

    const [url, init] = deps.fetchFn.mock.calls[0];
    expect(String(url)).toBe("https://api.voyageai.com/v1/embeddings");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("voyage-code-3");
    expect(body.input).toEqual(["always use X"]);
    expect(body.input_type).toBe("document");
    expect(init.headers.Authorization).toBe("Bearer voyage-key");

    const doc = deps.insertOne.mock.calls[0][0];
    expect(doc).toMatchObject({
      repo: "org/repo",
      text: "always use X",
      source: "command",
      author: "alice",
      prNumber: 7,
      embedding: EMBEDDING,
    });
    expect(typeof doc.createdAt).toBe("string");
  });

  it("insert caps oversized text", async () => {
    const deps = makeDeps();
    const client = createKnowledgeClient(ENV, deps)!;

    await client.insert({ repo: "org/repo", text: "x".repeat(5000), source: "command", author: "a" });

    const doc = deps.insertOne.mock.calls[0][0];
    expect(doc.text.length).toBeLessThanOrEqual(2000);
  });

  it("search embeds the query (query input_type) and issues a $vectorSearch filtered by repo", async () => {
    const deps = makeDeps();
    const client = createKnowledgeClient(ENV, deps)!;

    const results = await client.search("org/repo", "diff text here", 5);

    const body = JSON.parse(deps.fetchFn.mock.calls[0][1].body);
    expect(body.input_type).toBe("query");

    const pipeline = deps.aggregate.mock.calls[0][0];
    const stage = pipeline[0].$vectorSearch;
    expect(stage.path).toBe("embedding");
    expect(stage.queryVector).toEqual(EMBEDDING);
    expect(stage.limit).toBe(5);
    expect(stage.numCandidates).toBeGreaterThanOrEqual(100);
    expect(stage.filter).toEqual({ repo: "org/repo" });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ text: "we always use X for Y", source: "command", author: "alice" });
  });

  it("Voyage failure rejects with a structured error (callers warn and proceed)", async () => {
    const deps = makeDeps();
    deps.fetchFn.mockResolvedValue({ ok: false, status: 401 });
    const client = createKnowledgeClient(ENV, deps)!;

    await expect(client.insert({ repo: "r", text: "t", source: "command", author: "a" })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });

  it("insert with empty text rejects with VALIDATION", async () => {
    const client = createKnowledgeClient(ENV, makeDeps())!;
    await expect(client.insert({ repo: "r", text: "  ", source: "command", author: "a" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});
