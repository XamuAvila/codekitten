import { describe, expect, it, afterAll } from "vitest";

import { createKnowledgeClient } from "../../src/knowledge/client.js";

/**
 * Real Voyage + Atlas integration test (KIT-037).
 *
 * Skipped unless MONGODB_URI and VOYAGE_API_KEY are set — same policy as the
 * DeepSeek suite (llm-integration.test.ts): CI does not run this; developers
 * run it explicitly with real secrets. Proves the embed → insert → vector
 * search roundtrip mocks cannot cover. Requires the knowledge_vector_index
 * to exist on kitten.knowledge (bootstrap in scripts/minikube-setup.sh).
 */
const uri = process.env["MONGODB_URI"];
const voyageKey = process.env["VOYAGE_API_KEY"];

const describeIntegration = uri && voyageKey ? describe : describe.skip;

const TEST_REPO = `kitten-integration-test/${process.pid}`;

describeIntegration("Knowledge store real integration (Voyage + Atlas)", () => {
  const client = createKnowledgeClient({
    MONGODB_URI: uri,
    VOYAGE_API_KEY: voyageKey,
    ...(process.env["VOYAGE_BASE_URL"] ? { VOYAGE_BASE_URL: process.env["VOYAGE_BASE_URL"] } : {}),
  })!;

  afterAll(async () => {
    await client.close();
  });

  it("insert → vector search roundtrip returns the stored fact", async () => {
    const fact = "we always validate webhook payloads with zod strict schemas";
    await client.insert({ repo: TEST_REPO, text: fact, source: "command", author: "integration-test" });

    // Atlas vector indexes are eventually consistent — poll briefly.
    let results: readonly { text: string }[] = [];
    for (let attempt = 0; attempt < 15 && results.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      results = await client.search(TEST_REPO, "how do we validate incoming webhook data?", 3);
    }

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.text).toBe(fact);
  }, 60_000);
});
