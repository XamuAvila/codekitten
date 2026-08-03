import { parseReviewerConfig, DEFAULT_CONFIG, AppError, createLlmAdapter } from "@kitten/shared";
import type { ReviewContext, ReviewJob } from "@kitten/shared";
import { cloneRepo } from "./git/clone.js";
import { generateDiff } from "./git/diff.js";
import { fetchPrFiles } from "./git/files.js";
import { readChangedFiles } from "./git/read-files.js";
import { buildReviewPrompt } from "./prompt/build-prompt.js";
import { callWithRetry } from "./pipeline/retry.js";
import { postReviewComment } from "./github/comment.js";
import { postPrReview } from "./github/review.js";
import type { PipelineConfig, PipelineResult } from "./types.js";
import fs from "node:fs";

/**
 * Runs the full review pipeline:
 *   clone → diff → fetch PR files → read config → build prompt → LLM review
 *   → post findings → cleanup.
 * Returns a PipelineResult with status and metadata.
 * Cleanup is guaranteed in the finally block.
 *
 * The AnthropicAdapter is the only adapter in this card; KIT-012 replaces
 * resolveApiKey + adapter construction with the createLlmAdapter factory.
 */
export async function runPipeline(
  config: PipelineConfig,
): Promise<PipelineResult> {
  const start = Date.now();
  const cloneDir = `/tmp/clones/${config.jobId}`;
  let reviewerConfig: ConfigReadResult | undefined;

  try {
    // 1. Clone (full clone, all branches)
    console.log(`[reviewer] Processing job: review-${config.repo.replace("/", "-")}-${config.prNumber}`);
    console.log(`[reviewer] Cloning ${config.repo}...`);
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
    reviewerConfig = readConfigFromRepo(cloneDir);
    if (reviewerConfig.found) {
      console.log(
        `[reviewer] Config loaded: language=${reviewerConfig.config.language}, ` +
        `model=${reviewerConfig.config.model}, skip=${reviewerConfig.config.skip.length} patterns`,
      );
    } else {
      console.log("[reviewer] Config: .reviewer.yml not found, using defaults");
    }

    // 5. Read changed file contents (for the LLM prompt)
    const files = await readChangedFiles(cloneDir, prFiles);

    // 6. Build the monolithic guardrailed prompt
    const conventions = readConventions(cloneDir, reviewerConfig.config.conventionsFile);
    const prompt = buildReviewPrompt(diff.raw, files, reviewerConfig.config, conventions);

    // 7. Call the LLM (retry transient failures; never retry auth)
    // Factory selects the SDK by provider and the key by base_url (KIT-012).
    const adapter = createLlmAdapter(reviewerConfig.config);

    const job: ReviewJob = {
      repo: config.repo,
      prNumber: config.prNumber,
      headRef: config.headRef,
      baseRef: config.baseRef,
      sender: "system",
      isReReview: false,
    };

    const context: ReviewContext = {
      job,
      config: reviewerConfig.config,
      files,
      diff: diff.raw,
      prompt,
    };

    console.log(`[reviewer] Calling LLM: ${reviewerConfig.config.model} (base_url ${reviewerConfig.config.baseUrl ?? "provider default"})`);
    const result = await callWithRetry(() => adapter.review(context), {
      isRetryable: (error) => !isAuthError(error),
    });
    console.log(`[reviewer] LLM review complete: ${result.findings.length} findings`);

    // 8. Post findings as a PR review with inline comments (non-fatal).
    //    Zero findings → plain issue comment stating no issues found.
    //    Build the patch map from PR files, filtering out files without a
    //    patch (binary/removed — they cannot anchor inline, fall to table).
    const filePatches = new Map(
      prFiles
        .filter((f) => f.patch !== undefined)
        .map((f) => [f.filename, f.patch!]),
    );

    if (result.findings.length === 0) {
      await postReviewComment(config.token, config.repo, config.prNumber, {
        repo: config.repo,
        prNumber: config.prNumber,
        fileCount: { total: prFiles.length, analyzed: files.length, skipped: prFiles.length - files.length },
        tokenEstimate: result.metadata.inputTokens + result.metadata.outputTokens,
        model: result.metadata.model,
        diff: { insertions: diff.insertions, deletions: diff.deletions },
        findingsBody: noIssuesComment(),
      });
    } else {
      const posted = await postPrReview(
        config.token,
        config.repo,
        config.prNumber,
        result.findings,
        filePatches,
      );
      console.log(`[reviewer] PR review posted: ${posted.postedInline} inline, ${posted.inTable} in table`);
    }

    const durationMs = Date.now() - start;
    console.log(`[reviewer] Job completed in ${(durationMs / 1000).toFixed(1)}s`);

    return {
      status: "completed",
      dryRun: false,
      diff,
      findings: result.findings,
      prompt,
      metadata: { repo: config.repo, prNumber: config.prNumber, durationMs },
    };
  } catch (error) {
    const durationMs = Date.now() - start;
    // Map auth failures to a structured AUTH_FAILED error (never retried)
    const mapped = isAuthError(error)
      ? new AppError(
          "AUTH_FAILED",
          error instanceof Error ? error.message : String(error),
          [{ baseUrl: reviewerConfig?.config.baseUrl ?? undefined }],
        )
      : error;
    const message =
      mapped instanceof AppError
        ? `[${mapped.code}] ${mapped.message}`
        : mapped instanceof Error
          ? mapped.message
          : String(mapped);
    const details = mapped instanceof Error && "details" in mapped ? JSON.stringify((mapped as Record<string, unknown>).details) : "";
    console.error(`[reviewer] Job failed: ${message}${details ? ` | ${details}` : ""}`);

    return {
      status: "failed",
      dryRun: false,
      error: message,
      metadata: { repo: config.repo, prNumber: config.prNumber, durationMs },
    };
  } finally {
    // Cleanup even on failure — invariant: clone dirs are always cleaned up
    cleanup(cloneDir);
  }
}

function isAuthError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ("isAuth" in error || (error as { status?: unknown }).status === 401)
  );
}

function noIssuesComment(): string {
  return [
    `🐱 **Kitten Review** [KITTEN-TEST]`,
    ``,
    `No issues found — the LLM review did not report any findings.`,
  ].join("\n");
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

function readConventions(repoDir: string, conventionsFile: string): string | undefined {
  const path = `${repoDir}/${conventionsFile}`;
  if (!fs.existsSync(path)) return undefined;
  try {
    return fs.readFileSync(path, "utf-8");
  } catch {
    return undefined;
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
