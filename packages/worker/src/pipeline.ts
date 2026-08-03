import type { ReviewJob, ReviewerConfig } from "@kitten/shared";
import { parseReviewerConfig, DEFAULT_CONFIG } from "@kitten/shared";
import { cloneRepo } from "./git/clone.js";
import { countRepoFiles } from "./git/files.js";
import { dryRunAnalysis } from "./analyzer/dry-run.js";
import type { PipelineResult, DryRunContext } from "./types.js";
import fs from "node:fs";

/**
 * Runs the full review pipeline: clone → config → count files → dry-run → cleanup.
 * Returns a PipelineResult with status and metadata.
 * Cleanup is guaranteed in the finally block.
 */
export async function runPipeline(
  job: ReviewJob,
  config: ReviewerConfig,
  workDir: string,
): Promise<PipelineResult> {
  const start = Date.now();

  try {
    // 1. Clone
    console.log(`[worker] Processing job: review-${job.repo.replace("/", "-")}-${job.prNumber}`);
    console.log(`[worker] Cloning ${job.repo} (depth=1)...`);
    const clone = await cloneRepo(job.repo, job.headRef, workDir);
    console.log(`[worker] Clone complete: ${formatBytes(clone.sizeBytes)}`);

    // 2. Read config from cloned repo
    const configResult = readConfigFromRepo(workDir, config);
    if (configResult.found) {
      console.log(
        `[worker] Config loaded: language=${configResult.config.language}, ` +
        `model=${configResult.config.model}, skip=${configResult.config.skip.length} patterns`,
      );
    } else {
      console.log("[worker] Config: .reviewer.yml not found, using defaults");
    }
    const effectiveConfig = configResult.config;

    // 3. Count files
    const changedFiles = job.changedFiles;
    let source: string;
    if (changedFiles && changedFiles.length > 0) {
      source = `changedFiles from payload (${changedFiles.length} files)`;
    } else {
      source = `all files in repo — no changedFiles in payload`;
    }
    console.log(`[worker] Source: ${source}`);
    const fileCount = countRepoFiles(workDir, effectiveConfig);

    // 4. Dry run
    const context: DryRunContext = { job, config: effectiveConfig, fileCount };
    // rough total chars estimate from file sizes
    const totalChars = clone.sizeBytes; // bytes ≈ chars for text files
    const result = dryRunAnalysis(context, totalChars);

    // 5. Cleanup
    cleanup(workDir);

    const durationMs = Date.now() - start;
    console.log(`[worker] Job completed in ${(durationMs / 1000).toFixed(1)}s`);

    return {
      status: "completed",
      dryRun: result.dryRun,
      metadata: { repo: job.repo, prNumber: job.prNumber, durationMs },
    };
  } catch (error) {
    // Cleanup even on failure
    cleanup(workDir);

    const durationMs = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[worker] Job failed: ${message}`);

    return {
      status: "failed",
      dryRun: true,
      error: message,
      metadata: { repo: job.repo, prNumber: job.prNumber, durationMs },
    };
  }
}

interface ConfigReadResult {
  readonly found: boolean;
  readonly config: ReviewerConfig;
}

function readConfigFromRepo(
  repoDir: string,
  fallbackConfig: ReviewerConfig,
): ConfigReadResult {
  const conventionsFile = fallbackConfig.conventionsFile;
  const configPath = `${repoDir}/${conventionsFile}`;

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
      console.log("[worker] Cleanup: removed clone dir");
    }
  } catch {
    console.warn("[worker] Cleanup: failed to remove clone dir");
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
