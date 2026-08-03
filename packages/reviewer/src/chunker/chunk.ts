import type { ReviewFile } from "@kitten/shared";

/**
 * Token estimation — chars / 4 rounded up (same heuristic as the v2
 * dry-run). No real tokenizer in v3; chunks are sized with a 90% safety
 * margin (see splitFilesIntoChunks) to absorb drift. Real token counting
 * is a future refinement.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface Chunk {
  readonly files: readonly ReviewFile[];
  readonly estimatedTokens: number;
}

/**
 * Splits changed files into budget-sized chunks for multi-round review
 * (KIT-014, US-014).
 *
 * Strategy:
 * - files sorted largest-first (estimated tokens)
 * - packed into the current chunk until adding the next file would exceed
 *   the budget; then a new chunk starts
 * - the guardrailed prompt (system + diff + conventions) repeats per chunk,
 *   so `promptOverheadTokens` counts against every chunk's budget
 * - a single file larger than the budget goes in its own chunk (may exceed
 *   the budget — its failure is contained per KIT-014 decision 5)
 */
export function splitFilesIntoChunks(
  files: readonly ReviewFile[],
  maxContextTokens: number,
  promptOverheadTokens: number,
): readonly Chunk[] {
  if (files.length === 0) return [];

  // 90% safety margin — chars/4 underestimates code tokens
  const budget = Math.floor(maxContextTokens * 0.9);
  const sorted = [...files].sort(
    (a, b) => estimateTokens(b.content) - estimateTokens(a.content),
  );

  const chunks: Chunk[] = [];
  let current: ReviewFile[] = [];
  let currentTokens = 0;

  for (const f of sorted) {
    const fileTokens = estimateTokens(f.content);

    // Start a new chunk when the current one would overflow
    if (
      current.length > 0 &&
      currentTokens + promptOverheadTokens + fileTokens > budget
    ) {
      chunks.push({ files: current, estimatedTokens: currentTokens });
      current = [];
      currentTokens = 0;
    }

    current.push(f);
    currentTokens += fileTokens;
  }

  if (current.length > 0) {
    chunks.push({ files: current, estimatedTokens: currentTokens });
  }

  return chunks;
}
