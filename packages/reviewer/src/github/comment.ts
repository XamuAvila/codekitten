import { Octokit } from "@octokit/rest";
import type { Finding } from "@kitten/shared";
import type { ReviewCommentData } from "../types.js";

/**
 * Post the initial review placeholder comment on the PR.
 * Non-fatal: logs error but does not throw.
 * Uses the GitHub Issues API (PRs are issues) to create a comment.
 */
export async function postReviewComment(
  token: string,
  repo: string,
  prNumber: number,
  summary: ReviewCommentData,
): Promise<void> {
  const body = formatReviewComment(summary);

  try {
    const [owner, repoName] = repo.split("/");
    if (!owner || !repoName) {
      console.error("[reviewer] Invalid repo format for comment — expected 'owner/repo'");
      return;
    }

    const octokit = new Octokit({ auth: token });
    await octokit.issues.createComment({
      owner,
      repo: repoName,
      issue_number: prNumber,
      body,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[reviewer] Failed to post review comment: ${message}`);
  }
}

/**
 * Post a follow-up acknowledgment comment on the PR.
 * Non-fatal: logs error but does not throw.
 */
export async function postFollowUpAck(
  token: string,
  repo: string,
  prNumber: number,
  message: string,
): Promise<void> {
  const body = formatFollowUpAck(message);

  try {
    const [owner, repoName] = repo.split("/");
    if (!owner || !repoName) {
      console.error("[reviewer] Invalid repo format for follow-up ack — expected 'owner/repo'");
      return;
    }

    const octokit = new Octokit({ auth: token });
    await octokit.issues.createComment({
      owner,
      repo: repoName,
      issue_number: prNumber,
      body,
    });
  } catch (error: unknown) {
    const message_ = error instanceof Error ? error.message : String(error);
    console.error(`[reviewer] Failed to post follow-up ack: ${message_}`);
  }
}

/**
 * Formats the initial review comment body.
 * With `findingsBody` (v3) the body is the findings table; without it, the
 * dry-run summary (v2) is used. Includes [KITTEN-TEST] prefix.
 */
function formatReviewComment(summary: ReviewCommentData): string {
  if (summary.findingsBody) {
    return summary.findingsBody;
  }

  const { repo, prNumber, fileCount, tokenEstimate, model, diff } = summary;
  const tokensK = (tokenEstimate / 1000).toFixed(1);

  return [
    `🐱 **Kitten Review** [KITTEN-TEST]`,
    ``,
    `**Repo:** ${repo} | **PR:** #${prNumber} | **Files:** ${fileCount.total}`,
    ``,
    `---`,
    ``,
    `📋 **Dry Run Summary**`,
    `- Token estimate: ${tokensK}k tokens`,
    `- Model: ${model}`,
    `- Files analyzed: ${fileCount.analyzed} (${fileCount.skipped} skipped)`,
    `- Diff: +${diff.insertions} -${diff.deletions}`,
    ``,
    `> This is a dry-run review (v2). Real LLM analysis coming in v3.`,
  ].join("\n");
}

/**
 * Formats the review comment body with real findings (v3).
 * Markdown table: severity | file:line | finding | suggestion.
 * Includes [KITTEN-TEST] prefix for test fixture identification.
 */
export function formatFindingsComment(
  findings: readonly Finding[],
  meta: {
    readonly repo: string;
    readonly prNumber: number;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly insertions: number;
    readonly deletions: number;
  },
): string {
  const rows = findings.map((f) => {
    const location = `${f.file}:${f.line}`;
    const suggestion = f.suggestion ? f.suggestion.replace(/\n/g, " ") : "-";
    return `| ${f.severity} | ${location} | ${f.finding} | ${suggestion} |`;
  });

  return [
    `🐱 **Kitten Review** [KITTEN-TEST]`,
    ``,
    `**Repo:** ${meta.repo} | **PR:** #${meta.prNumber} | **Findings:** ${findings.length}`,
    ``,
    `---`,
    ``,
    `## Findings`,
    ``,
    `| Severity | File:Line | Finding | Suggestion |`,
    `|---|---|---|---|`,
    ...rows,
    ``,
    `> Model: ${meta.model} · +${meta.insertions} -${meta.deletions} · ` +
      `${meta.inputTokens} in / ${meta.outputTokens} out tokens`,
  ].join("\n");
}

/**
 * Post a follow-up answer (real LLM response, KIT-017) on the PR.
 * Non-fatal: logs error but does not throw.
 */
export async function postFollowUpAnswer(
  token: string,
  repo: string,
  prNumber: number,
  answer: string,
): Promise<void> {
  const body = [
    `🐱 **Kitten** [KITTEN-TEST]`,
    ``,
    answer,
  ].join("\n");

  try {
    const [owner, repoName] = repo.split("/");
    if (!owner || !repoName) {
      console.error("[reviewer] Invalid repo format for follow-up answer — expected 'owner/repo'");
      return;
    }

    const octokit = new Octokit({ auth: token });
    await octokit.issues.createComment({
      owner,
      repo: repoName,
      issue_number: prNumber,
      body,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[reviewer] Failed to post follow-up answer: ${message}`);
  }
}

/**
 * Formats the follow-up acknowledgment comment body.
 * Includes [KITTEN-TEST] prefix for test fixture identification.
 */
function formatFollowUpAck(message: string): string {
  return [
    `🐱 **Kitten** [KITTEN-TEST]`,
    ``,
    `Received your message: "${message}"`,
    ``,
    `> Follow-up processing with LLM available in v3.`,
  ].join("\n");
}
