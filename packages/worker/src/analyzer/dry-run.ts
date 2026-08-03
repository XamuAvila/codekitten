import type { DryRunContext, DryRunResult } from "../types.js";

/**
 * Computes a dry-run result — logs what WOULD happen if an LLM were called,
 * and returns structured data. No LLM call is made.
 */
export function dryRunAnalysis(
  context: DryRunContext,
  totalChars: number,
): DryRunResult {
  const tokenEstimate = Math.ceil(totalChars / 4);

  console.log(`[worker] Files in repo: ${context.fileCount.total}`);
  console.log(`[worker] Files after skip patterns: ${context.fileCount.filtered}`);
  if (context.fileCount.skipped > 0) {
    console.log(`[worker] Skipped ${context.fileCount.skipped} files by pattern`);
  }
  console.log(`[worker] DRY RUN — would send ${tokenEstimate}k tokens to ${context.config.model}`);
  console.log("[worker] DRY RUN — would post PR comment with findings");

  return {
    dryRun: true,
    model: context.config.model,
    tokenEstimate,
    fileCount: context.fileCount,
  };
}
