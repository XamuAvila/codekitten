import type { KnowledgeClient, KnowledgeSearchResult } from "@kitten/shared";

/**
 * Knowledge few-shot block (KIT-039, US-034): top-K knowledge entries by
 * vector similarity to the diff, rendered as a "Repository knowledge" prompt
 * block for BOTH review paths. Retrieval failure NEVER fails the review —
 * empty block + warning (epic error table).
 */

export function buildKnowledgeBlock(entries: readonly KnowledgeSearchResult[]): string {
  if (entries.length === 0) {
    return "";
  }
  const lines = entries.map((entry, index) => {
    const attribution =
      entry.source === "correction" ? `(correction by ${entry.author})` : `(taught by ${entry.author})`;
    return `${index + 1}. ${entry.text} ${attribution}`;
  });
  return ["Repository knowledge:", ...lines].join("\n");
}

/**
 * Fetches top-K entries for the repo using the diff as the relevance anchor
 * (card decision 2). Undefined client (secrets unset) → empty, silently —
 * the boot warning already fired in pipeline.ts.
 */
export async function fetchKnowledge(
  client: KnowledgeClient | undefined,
  repo: string,
  diff: string,
  topK: number,
): Promise<readonly KnowledgeSearchResult[]> {
  if (client === undefined) {
    return [];
  }
  try {
    return await client.search(repo, diff, topK);
  } catch (error) {
    console.warn(
      `[reviewer] knowledge retrieval failed — reviewing without it: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}
