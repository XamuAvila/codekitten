import { MongoClient } from "mongodb";

import { AppError } from "../types/index.js";

/**
 * KnowledgeClient (KIT-037) — per-repo curated knowledge on MongoDB Atlas
 * Vector Search with Voyage embeddings. Knowledge TEXT only — code embeddings
 * live in the Semble sidecar (epic D3), never here.
 *
 * Atlas vector index (created once per deployment — bootstrap step in
 * scripts/minikube-setup.sh, KIT-040):
 *
 *   collection.createSearchIndex("knowledge_vector_index", "vectorSearch", {
 *     fields: [
 *       { type: "vector", path: "embedding", numDimensions: 1024, similarity: "cosine" },
 *       { type: "filter", path: "repo" },
 *     ],
 *   })
 *
 * Sources (Context7/official docs, 2026-08-05): Voyage voyage-code-3 REST
 * (1024 dims default, 32k-token context), Atlas $vectorSearch stage (node
 * driver v6+). See KIT-037 card for the full research record.
 */

export type KnowledgeSource = "command" | "correction";

export interface KnowledgeInsert {
  readonly repo: string;
  readonly text: string;
  readonly source: KnowledgeSource;
  readonly author: string;
  readonly prNumber?: number;
}

export interface KnowledgeSearchResult {
  readonly text: string;
  readonly source: KnowledgeSource;
  readonly author: string;
  readonly score: number;
}

export interface KnowledgeClient {
  insert(input: KnowledgeInsert): Promise<void>;
  search(repo: string, queryText: string, topK: number): Promise<readonly KnowledgeSearchResult[]>;
  close(): Promise<void>;
}

interface CollectionLike {
  insertOne(doc: Record<string, unknown>): Promise<unknown>;
  aggregate(pipeline: Record<string, unknown>[]): { toArray(): Promise<Record<string, unknown>[]> };
}

interface MongoLike {
  db(name?: string): { collection(name: string): CollectionLike };
  close(): Promise<void>;
}

/** Injection seam for tests — production uses the real driver + global fetch. */
export interface KnowledgeDeps {
  readonly connect?: (uri: string) => Promise<MongoLike>;
  readonly fetchFn?: typeof fetch;
}

export const VOYAGE_MODEL = "voyage-code-3";
export const VOYAGE_DIMENSIONS = 1024;
export const VECTOR_INDEX_NAME = "knowledge_vector_index";
/**
 * Default host serves keys created at voyageai.com. Keys provisioned through
 * MongoDB Atlas ("AI Models" in the Atlas UI) only work against
 * https://ai.mongodb.com — set VOYAGE_BASE_URL for those (same body/auth).
 */
const DEFAULT_VOYAGE_BASE_URL = "https://api.voyageai.com";
const DB_NAME = "kitten";
const COLLECTION = "knowledge";
/** Prompt-growth guard (KIT-039 risk): entries are capped at insert time. */
const MAX_TEXT_LENGTH = 2000;
/** Voyage truncates at 32k tokens anyway; cap query text well below that. */
const MAX_QUERY_LENGTH = 40_000;

/**
 * Returns a client when both secrets are present, undefined otherwise —
 * callers skip the knowledge pillars with a warning (epic error table).
 */
export function createKnowledgeClient(
  env: {
    readonly MONGODB_URI?: string;
    readonly VOYAGE_API_KEY?: string;
    readonly VOYAGE_BASE_URL?: string;
  },
  deps?: KnowledgeDeps,
): KnowledgeClient | undefined {
  const { MONGODB_URI: uri, VOYAGE_API_KEY: voyageKey } = env;
  const voyageEndpoint = `${(env.VOYAGE_BASE_URL ?? DEFAULT_VOYAGE_BASE_URL).replace(/\/$/, "")}/v1/embeddings`;
  if (uri === undefined || uri === "" || voyageKey === undefined || voyageKey === "") {
    return undefined;
  }

  const connect = deps?.connect ?? (async (u: string) => (await MongoClient.connect(u)) as unknown as MongoLike);
  const fetchFn = deps?.fetchFn ?? fetch;
  let clientPromise: Promise<MongoLike> | undefined;

  const collection = async (): Promise<CollectionLike> => {
    clientPromise ??= connect(uri);
    return (await clientPromise).db(DB_NAME).collection(COLLECTION);
  };

  const embed = async (text: string, inputType: "document" | "query"): Promise<number[]> => {
    let response: Response;
    try {
      response = await fetchFn(voyageEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${voyageKey}` },
        body: JSON.stringify({
          model: VOYAGE_MODEL,
          input: [text],
          input_type: inputType,
          output_dimension: VOYAGE_DIMENSIONS,
        }),
      });
    } catch (error) {
      throw new AppError("SERVICE_UNAVAILABLE", "Voyage embeddings request failed", [
        { message: error instanceof Error ? error.message : String(error) },
      ]);
    }
    if (!response.ok) {
      throw new AppError("SERVICE_UNAVAILABLE", "Voyage embeddings returned an error", [
        { status: response.status },
      ]);
    }
    const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
    const embedding = payload.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
      throw new AppError("SERVICE_UNAVAILABLE", "Voyage embeddings response missing data[0].embedding", []);
    }
    return embedding;
  };

  return {
    async insert(input: KnowledgeInsert): Promise<void> {
      const text = input.text.trim().slice(0, MAX_TEXT_LENGTH);
      if (text === "") {
        throw new AppError("VALIDATION", "Knowledge text must not be empty", []);
      }
      const embedding = await embed(text, "document");
      const col = await collection();
      await col.insertOne({
        repo: input.repo,
        text,
        embedding,
        source: input.source,
        author: input.author,
        ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
        createdAt: new Date().toISOString(),
      });
    },

    async search(repo: string, queryText: string, topK: number): Promise<readonly KnowledgeSearchResult[]> {
      const embedding = await embed(queryText.slice(0, MAX_QUERY_LENGTH), "query");
      const col = await collection();
      const rows = await col
        .aggregate([
          {
            $vectorSearch: {
              index: VECTOR_INDEX_NAME,
              path: "embedding",
              queryVector: embedding,
              numCandidates: Math.max(topK * 20, 100),
              limit: topK,
              filter: { repo },
            },
          },
          {
            $project: {
              _id: 0,
              text: 1,
              source: 1,
              author: 1,
              score: { $meta: "vectorSearchScore" },
            },
          },
        ])
        .toArray();
      return rows.map((row) => ({
        text: String(row.text),
        source: row.source === "correction" ? "correction" : "command",
        author: String(row.author ?? "unknown"),
        score: typeof row.score === "number" ? row.score : 0,
      }));
    },

    async close(): Promise<void> {
      if (clientPromise !== undefined) {
        await (await clientPromise).close();
      }
    },
  };
}
