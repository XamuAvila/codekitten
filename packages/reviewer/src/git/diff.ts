import { simpleGit } from "simple-git";
import { AppError } from "@kitten/shared";

import type { DiffResult } from "../types.js";

/**
 * Generates the diff between baseRef and headRef using three-dot syntax.
 * Fetches baseRef first (shallow clone may not have it), then diffs.
 * Returns DiffResult with raw diff text and parsed stats.
 */
export async function generateDiff(
  repoDir: string,
  baseRef: string,
  headRef: string,
): Promise<DiffResult> {
  const git = simpleGit(repoDir);

  try {
    // Full clone — use origin refs for comparison
    const diffSpec = `origin/${baseRef}...origin/${headRef}`;
    const raw = await git.diff([diffSpec]);
    const summary = await git.diffSummary([diffSpec]);

    return {
      raw,
      filesChanged: summary.changed,
      insertions: summary.insertions,
      deletions: summary.deletions,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError(
      "NOT_FOUND",
      "Failed to generate diff",
      [{ repoDir, baseRef, headRef, detail: message }],
    );
  }
}
