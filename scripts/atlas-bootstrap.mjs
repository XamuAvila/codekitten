#!/usr/bin/env node
// Idempotent Atlas Vector Search index bootstrap (KIT-040).
// Creates knowledge_vector_index on kitten.knowledge when missing — the index
// definition mirrors packages/shared/src/knowledge/client.ts (change both).
// Usage: MONGODB_URI=... node scripts/atlas-bootstrap.mjs
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("[atlas-bootstrap] MONGODB_URI not set — skipping");
  process.exit(1);
}

const INDEX_NAME = "knowledge_vector_index";
const client = await MongoClient.connect(uri);
try {
  const collection = client.db("kitten").collection("knowledge");
  // createSearchIndex fails on an empty namespace in some tiers — ensure the
  // collection exists first (no-op when present).
  await client.db("kitten").createCollection("knowledge").catch(() => {});

  const existing = await collection.listSearchIndexes(INDEX_NAME).toArray().catch(() => []);
  if (existing.length > 0) {
    console.log(`[atlas-bootstrap] ${INDEX_NAME} already exists (status: ${existing[0].status ?? "?"})`);
  } else {
    await collection.createSearchIndex({
      name: INDEX_NAME,
      type: "vectorSearch",
      definition: {
        fields: [
          { type: "vector", path: "embedding", numDimensions: 1024, similarity: "cosine" },
          { type: "filter", path: "repo" },
        ],
      },
    });
    console.log(`[atlas-bootstrap] ${INDEX_NAME} created (build is async — poll listSearchIndexes for READY)`);
  }
} finally {
  await client.close();
}
