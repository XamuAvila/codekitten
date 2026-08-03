import { Octokit } from "@octokit/rest";
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
 * Formats the initial review comment body using the dry-run summary data.
 * Includes [KITTEN-TEST] prefix for test fixture identification.
 */
function formatReviewComment(summary: ReviewCommentData): string {
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
