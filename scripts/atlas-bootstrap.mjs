#!/usr/bin/env node
// Idempotent Atlas Vector Search index bootstrap (KIT-040).
// Creates knowledge_vector_index on kitten.knowledge when missing — the index
// definition mirrors packages/shared/src/knowledge/client.ts (change both).
// Usage: MONGODB_URI=... node scripts/atlas-bootstrap.mjs
// pnpm strict node_modules: mongodb is a dependency of @kitten/shared, not of
// the repo root — resolve it from the shared package regardless of cwd.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "shared", "package.json"),
);
const { MongoClient } = require("mongodb");

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
