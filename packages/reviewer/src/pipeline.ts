import { parseReviewerConfig, DEFAULT_CONFIG } from "@kitten/shared";
import { cloneRepo } from "./git/clone.js";
import { generateDiff } from "./git/diff.js";
import { fetchPrFiles } from "./git/files.js";
import { dryRunAnalysis } from "./analyzer/dry-run.js";
import type { PipelineConfig, PipelineResult, DryRunContext, FileCount, ReviewCommentData } from "./types.js";
import { postReviewComment } from "./github/comment.js";
import fs from "node:fs";

/**
 * Runs the full review pipeline:
 *   clone → diff → fetch PR files → read config → dry-run → cleanup.
 * Returns a PipelineResult with status and metadata.
 * Cleanup is guaranteed in the finally block.
 */
export async function runPipeline(
  config: PipelineConfig,
): Promise<PipelineResult> {
  const start = Date.now();
  const cloneDir = `/tmp/clones/${config.jobId}`;

  try {
    // 1. Clone
    console.log(`[reviewer] Processing job: review-${config.repo.replace("/", "-")}-${config.prNumber}`);
    console.log(`[reviewer] Cloning ${config.repo} (depth=1)...`);
    const clone = await cloneRepo(config.repo, config.headRef, cloneDir, config.token);
    console.log(`[reviewer] Clone complete: ${formatBytes(clone.sizeBytes)}`);

    // 2. Diff
    console.log(`[reviewer] Generating diff ${config.baseRef}...${config.headRef}`);
    const diff = await generateDiff(cloneDir, config.baseRef, config.headRef);
    console.log(`[reviewer] Diff: ${diff.filesChanged} files changed, +${diff.insertions} -${diff.deletions}`);

    // 3. Fetch PR files from GitHub API
    console.log(`[reviewer] Fetching PR #${config.prNumber} files...`);
    const prFiles = await fetchPrFiles(config.repo, config.prNumber, config.token, config.skipPatterns);
    console.log(`[reviewer] PR files: ${prFiles.length}`);

    // 4. Read config from cloned repo
    const reviewerConfig = readConfigFromRepo(cloneDir);
    if (reviewerConfig.found) {
      console.log(
        `[reviewer] Config loaded: language=${reviewerConfig.config.language}, ` +
        `model=${reviewerConfig.config.model}, skip=${reviewerConfig.config.skip.length} patterns`,
      );
    } else {
      console.log("[reviewer] Config: .reviewer.yml not found, using defaults");
    }

    // 5. Dry run
    const fileCount: FileCount = {
      total: prFiles.length + (prFiles.length - prFiles.length), // total before filtering
      filtered: prFiles.length,
      skipped: 0,
    };
    const context: DryRunContext = {
      jobId: config.jobId,
      repo: config.repo,
      prNumber: config.prNumber,
      config: reviewerConfig.config,
      fileCount,
      diff,
    };
    const totalChars = clone.sizeBytes; // bytes ~ chars for text files
    const result = dryRunAnalysis(context, totalChars);

    // 6. Post placeholder comment on PR (non-fatal)
    const commentData: ReviewCommentData = {
      repo: config.repo,
      prNumber: config.prNumber,
      fileCount: { total: fileCount.total, analyzed: fileCount.filtered, skipped: fileCount.skipped },
      tokenEstimate: result.tokenEstimate,
      model: result.model,
      diff: { insertions: diff.insertions, deletions: diff.deletions },
    };
    await postReviewComment(config.token, config.repo, config.prNumber, commentData);

    const durationMs = Date.now() - start;
    console.log(`[reviewer] Job completed in ${(durationMs / 1000).toFixed(1)}s`);

    return {
      status: "completed",
      dryRun: result.dryRun,
      diff,
      metadata: { repo: config.repo, prNumber: config.prNumber, durationMs },
    };
  } catch (error) {
    const durationMs = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[reviewer] Job failed: ${message}`);

    return {
      status: "failed",
      dryRun: true,
      error: message,
      metadata: { repo: config.repo, prNumber: config.prNumber, durationMs },
    };
  } finally {
    // Cleanup even on failure — invariant: clone dirs are always cleaned up
    cleanup(cloneDir);
  }
}

interface ConfigReadResult {
  readonly found: boolean;
  readonly config: ReturnType<typeof parseReviewerConfig>;
}

function readConfigFromRepo(repoDir: string): ConfigReadResult {
  const configPath = `${repoDir}/.reviewer.yml`;

  if (!fs.existsSync(configPath)) {
    return { found: false, config: DEFAULT_CONFIG };
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return { found: true, config: parseReviewerConfig(content) };
  } catch {
    return { found: false, config: DEFAULT_CONFIG };
  }
}

function cleanup(workDir: string): void {
  try {
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
      console.log("[reviewer] Cleanup: removed clone dir");
    }
  } catch {
    console.warn("[reviewer] Cleanup: failed to remove clone dir");
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
