import { parseReviewerConfig, parseMcpConfig, DEFAULT_CONFIG, AppError, createLlmAdapter } from "@kitten/shared";
import type { MCPConfig, ReviewContext, ReviewFile, ReviewJob, ReviewResult } from "@kitten/shared";
import { buildAgenticPrompt, runAgenticLoop } from "./agentic/index.js";
import { createRegistry } from "./mcp/registry.js";
import { cloneRepo } from "./git/clone.js";
import { generateDiff } from "./git/diff.js";
import { fetchPrFiles } from "./git/files.js";
import { readChangedFiles } from "./git/read-files.js";
import { buildReviewPrompt } from "./prompt/build-prompt.js";
import { callWithRetry, isAuthError } from "./pipeline/retry.js";
import { splitFilesIntoChunks, consolidateFindings, estimateTokens } from "./chunker/index.js";
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
export interface PipelineOptions {
  /** Skip chunking — single full-context call (force command, KIT-015). */
  readonly ignoreBudget?: boolean;
  /** Abort between chunks — stop command (KIT-016). */
  readonly signal?: AbortSignal;
}

export async function runPipeline(
  config: PipelineConfig,
  opts?: PipelineOptions,
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

    // 4b. Read .reviewer-mcp.json — v4 agentic opt-in. Invalid/missing →
    //     fail-safe to the v3 monolithic path (a bad file never fails a review).
    const mcpConfig = readMcpConfigFromRepo(cloneDir);
    if (mcpConfig?.enabled) {
      console.log(`[reviewer] Agentic mode enabled (maxTurns=${mcpConfig.maxTurns}, tools=${mcpConfig.tools.join(",")})`);
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

    // 7b. Chunked multi-round review (KIT-014, US-014).
    //     Over the token budget → split files into chunks, review each in its
    //     own LLM call, consolidate findings. Under the budget → single call.
    //     A failed chunk is skipped with a warning appended to the comment.
    const budget = reviewerConfig.config.maxContextTokens;
    const promptOverhead = estimateTokens(prompt.system) + estimateTokens(diff.raw);
    // Agentic mode replaces the file-content chunking path (v4): the context
    // starts small (diff + index), so per-chunk LLM rounds are unnecessary.
    const chunks =
      mcpConfig?.enabled || (!opts?.ignoreBudget && estimateTokens(prompt.user) > budget)
        ? mcpConfig?.enabled
          ? [{ files, estimatedTokens: 0 }]
          : splitFilesIntoChunks(files, budget, promptOverhead)
        : [{ files, estimatedTokens: 0 }];

    const results: Array<{ result?: ReviewResult; error?: Error }> = [];
    let agenticToolCalls: number | undefined;
    let agenticHitBudget = false;

    if (mcpConfig?.enabled) {
      const registry = createRegistry(
        cloneDir,
        [...reviewerConfig.config.skip, ...mcpConfig.search.skip],
        mcpConfig,
      );
      const maxTurns = opts?.ignoreBudget ? mcpConfig.forceMaxTurns : mcpConfig.maxTurns;
      const agenticPrompt = buildAgenticPrompt(
        diff.raw,
        prFiles.map((file) => ({
          path: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patchBytes: file.patch !== undefined ? Buffer.byteLength(file.patch, "utf-8") : 0,
        })),
        reviewerConfig.config,
        conventions,
        mcpConfig,
        maxTurns,
      );
      try {
        const loop = await runAgenticLoop(adapter, agenticPrompt, mcpConfig, {
          registry,
          maxOutputTokens: reviewerConfig.config.maxOutputTokens,
          maxTurns,
          ...(opts?.signal ? { signal: opts.signal } : {}),
        });
        agenticToolCalls = loop.toolCalls;
        agenticHitBudget = loop.hitBudget;
        console.log(`[reviewer] Agentic loop done: ${loop.toolCalls} tool calls, hitBudget=${loop.hitBudget}${loop.aborted ? ", aborted" : ""}`);
        results.push({
          result: {
            findings: loop.findings,
            contextChecked: [],
            conventionsStatus: [],
            metadata: {
              model: reviewerConfig.config.model,
              inputTokens: 0,
              outputTokens: 0,
              durationMs: 0,
            },
          },
        });
      } catch (error) {
        results.push({ error: error instanceof Error ? error : new Error(String(error)) });
      }
    } else
    for (const [index, chunk] of chunks.entries()) {
      // Stop command aborts between chunks (KIT-016) — remaining chunks skipped
      if (opts?.signal?.aborted) {
        console.log(`[reviewer] Review aborted by stop command — ${chunks.length - index} chunks skipped`);
        break;
      }

      const chunkContext: ReviewContext = {
        ...context,
        files: chunk.files,
        prompt: {
          system: prompt.system,
          user: prompt.user.replace(filesBlock(context.files), filesBlock(chunk.files)),
        },
      };
      console.log(`[reviewer] Chunk ${index + 1}/${chunks.length} (${chunk.files.length} files, ~${chunk.estimatedTokens} tokens)`);
      try {
        const chunkResult = await callWithRetry(() => adapter.review(chunkContext), {
          isRetryable: (error) => !isAuthError(error),
        });
        results.push({ result: chunkResult });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[reviewer] Chunk ${index + 1} failed: ${err.message}`);
        results.push({ error: err });
      }
    }

    const successful = results.filter((r) => r.result !== undefined).map((r) => r.result!);
    const failedChunks = results.filter((r) => r.error !== undefined).length;

    // A single-call review that fails is a review failure (not contained —
    // there are no other chunks to fall back on). Multi-chunk failures are
    // contained per US-014 AC-4 (successful chunks still reported).
    if (successful.length === 0 && chunks.length === 1) {
      throw results[0]?.error ?? new Error("LLM review failed");
    }
    // Rule ids the repo actually declared — findings attributed to anything
    // else lose the attribution during consolidation (KIT-018, US-018 AC-5).
    const declaredRuleIds = new Set(reviewerConfig.config.rules.map((rule) => rule.id));

    const result: ReviewResult = successful.length > 0
      ? {
          findings: consolidateFindings(successful, declaredRuleIds),
          contextChecked: successful[0]?.contextChecked ?? [],
          conventionsStatus: successful[0]?.conventionsStatus ?? [],
          metadata: {
            model: successful[0]!.metadata.model,
            inputTokens: successful.reduce((sum, r) => sum + r.metadata.inputTokens, 0),
            outputTokens: successful.reduce((sum, r) => sum + r.metadata.outputTokens, 0),
            durationMs: successful.reduce((sum, r) => sum + r.metadata.durationMs, 0),
          },
        }
      : {
          findings: [],
          contextChecked: [],
          conventionsStatus: [],
          metadata: { model: reviewerConfig.config.model, inputTokens: 0, outputTokens: 0, durationMs: 0 },
        };

    const wasChunked = chunks.length > 1;
    if (wasChunked) {
      console.log(`[reviewer] LLM review complete: ${result.findings.length} findings (${chunks.length} chunks, ${failedChunks} failed)`);
    } else {
      console.log(`[reviewer] LLM review complete: ${result.findings.length} findings`);
    }

    // 8. Post findings as a PR review with inline comments (non-fatal).
    //    Zero findings → plain issue comment stating no issues found.
    //    Build the patch map from PR files, filtering out files without a
    //    patch (binary/removed — they cannot anchor inline, fall to table).
    const filePatches = new Map(
      prFiles
        .filter((f) => f.patch !== undefined)
        .map((f) => [f.filename, f.patch!]),
    );

    const chunkWarning =
      failedChunks > 0
        ? `\n\n> ⚠️ ${failedChunks} of ${chunks.length} chunks failed — their findings were skipped.`
        : "";

    if (result.findings.length === 0) {
      await postReviewComment(config.token, config.repo, config.prNumber, {
        repo: config.repo,
        prNumber: config.prNumber,
        fileCount: { total: prFiles.length, analyzed: files.length, skipped: prFiles.length - files.length },
        tokenEstimate: result.metadata.inputTokens + result.metadata.outputTokens,
        model: result.metadata.model,
        diff: { insertions: diff.insertions, deletions: diff.deletions },
        findingsBody: noIssuesComment() + chunkWarning,
      });
    } else {
      const posted = await postPrReview(
        config.token,
        config.repo,
        config.prNumber,
        result.findings,
        filePatches,
        reviewerConfig.config.blocking,
      );
      console.log(
        `[reviewer] PR review posted: ${posted.postedInline} inline, ${posted.inTable} in table, ` +
        `event=${posted.event}${posted.downgraded ? " (downgraded from REQUEST_CHANGES)" : ""}`,
      );
      if (chunkWarning) {
        // Failed chunks noted as a follow-up comment (US-014 AC-4)
        await postReviewComment(config.token, config.repo, config.prNumber, {
          repo: config.repo,
          prNumber: config.prNumber,
          fileCount: { total: prFiles.length, analyzed: files.length, skipped: prFiles.length - files.length },
          tokenEstimate: result.metadata.inputTokens + result.metadata.outputTokens,
          model: result.metadata.model,
          diff: { insertions: diff.insertions, deletions: diff.deletions },
          findingsBody: chunkWarning.trim(),
        });
      }
    }

    // 8b. Budget question — over the budget, invite `force` (KIT-015 consumes)
    if ((wasChunked || agenticHitBudget) && !opts?.ignoreBudget) {
      await postReviewComment(config.token, config.repo, config.prNumber, {
        repo: config.repo,
        prNumber: config.prNumber,
        fileCount: { total: prFiles.length, analyzed: files.length, skipped: prFiles.length - files.length },
        tokenEstimate: result.metadata.inputTokens + result.metadata.outputTokens,
        model: result.metadata.model,
        diff: { insertions: diff.insertions, deletions: diff.deletions },
        findingsBody: agenticHitBudget
          ? agenticBudgetComment(agenticToolCalls ?? 0)
          : budgetQuestionComment(budget),
      });
    }

    const durationMs = Date.now() - start;
    console.log(`[reviewer] Job completed in ${(durationMs / 1000).toFixed(1)}s`);

    return {
      status: "completed",
      dryRun: false,
      diff,
      findings: result.findings,
      prompt,
      llmConfig: reviewerConfig.config,
      ...(mcpConfig?.enabled ? { mcpConfig } : {}),
      metadata: {
        repo: config.repo,
        prNumber: config.prNumber,
        durationMs,
        ...(agenticToolCalls !== undefined ? { toolCalls: agenticToolCalls } : {}),
      },
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

function noIssuesComment(): string {
  return [
    `🐱 **Kitten Review** [KITTEN-TEST]`,
    ``,
    `No issues found — the LLM review did not report any findings.`,
  ].join("\n");
}

function budgetQuestionComment(budget: number): string {
  return [
    `🐱 **Kitten** [KITTEN-TEST]`,
    ``,
    `This PR exceeds the token budget (${budget.toLocaleString()} tokens). ` +
      `The review covered a subset of the changed files.`,
    ``,
    `Reply \`force\` to review the full PR without limits.`,
  ].join("\n");
}

function agenticBudgetComment(toolCalls: number): string {
  return [
    `🐱 **Kitten** [KITTEN-TEST]`,
    ``,
    `The agentic review hit its turn budget after ${toolCalls} tool call${toolCalls === 1 ? "" : "s"} — ` +
      `findings above may be incomplete.`,
    ``,
    `Reply \`force\` to re-run with a raised budget.`,
  ].join("\n");
}

/** Renders the changed-files block the way buildReviewPrompt does. */
function filesBlock(files: readonly ReviewFile[]): string {
  return files
    .map((file) => `### ${file.path}\n\`\`\`\n${file.content}\n\`\`\``)
    .join("\n\n");
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

/**
 * Reads .reviewer-mcp.json from the clone root (v4 opt-in). Missing →
 * undefined (v3 path). Invalid content → warning + undefined: a bad config
 * file must never fail a review (mirrors the .reviewer.yml fallback).
 */
function readMcpConfigFromRepo(repoDir: string): MCPConfig | undefined {
  const configPath = `${repoDir}/.reviewer-mcp.json`;

  if (!fs.existsSync(configPath)) {
    return undefined;
  }

  try {
    return parseMcpConfig(fs.readFileSync(configPath, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[reviewer] Invalid .reviewer-mcp.json — falling back to monolithic review: ${message}`);
    return undefined;
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
