import { Octokit } from "@octokit/rest";
import type { Finding, ReviewerConfig } from "@kitten/shared";

/** The two review actions Kitten submits. `APPROVE` is never used. */
type ReviewEvent = "COMMENT" | "REQUEST_CHANGES";

/**
 * Appended to the body when a blocking review had to be posted as a comment.
 * The reviewer must say so out loud: a maintainer who configured
 * `blocking: request_changes` would otherwise believe the merge is gated.
 */
const DOWNGRADE_NOTE =
  "> :warning: This repo is configured to request changes, but GitHub rejected that review action " +
  "(a review cannot request changes on a pull request opened by the same account). Posted as a comment instead.";

/**
 * Checks whether a line (new-file side) falls inside any hunk of a unified
 * diff patch (KIT-013).
 *
 * A hunk header is `@@ -oldStart,oldCount +newStart,newCount @@`. The new
 * side occupies newStart .. newStart+newCount-1 (added AND context lines).
 * A line outside every hunk cannot anchor an inline comment — the modern
 * GitHub API requires line to be part of the diff.
 */
export function isLineInPatch(patch: string, line: number): boolean {
  const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let match: RegExpExecArray | null;
  while ((match = hunkRe.exec(patch)) !== null) {
    const newStart = Number(match[1]);
    const newCount = match[2] ? Number(match[2]) : 1;
    if (line >= newStart && line < newStart + newCount) {
      return true;
    }
  }
  return false;
}

/**
 * Posts findings as a GitHub Pull Request Review (state COMMENTED) with
 * inline comments on diff lines (KIT-013, US-013).
 *
 * Hybrid strategy (mirrors CodeRabbit): a finding anchors inline only if its
 * line falls inside a hunk of the file's patch; unmappable findings (renamed,
 * removed, binary, or outside hunks) land in a Markdown table in the review
 * body. The table fallback never blocks the review.
 *
 * Modern API anchors: `path` + `line` + `side: "RIGHT"` + `subject_type:
 * "line"` (legacy `position` avoided — docs.github.com/rest/pulls/comments).
 *
 * `blocking` (KIT-020, US-020) selects the review action. It is required, not
 * optional-with-a-default, so a new call site cannot silently fall back to
 * non-blocking — that is the exact bug this parameter exists to remove.
 */
export async function postPrReview(
  token: string,
  repo: string,
  prNumber: number,
  findings: readonly Finding[],
  filePatches: ReadonlyMap<string, string>,
  blocking: ReviewerConfig["blocking"],
): Promise<{
  postedInline: number;
  inTable: number;
  event: ReviewEvent;
  downgraded: boolean;
}> {
  const inlineComments: Array<{
    path: string;
    line: number;
    side: "RIGHT";
    body: string;
  }> = [];
  const tableFindings: Finding[] = [];

  for (const finding of findings) {
    const patch = filePatches.get(finding.file);
    if (patch !== undefined && isLineInPatch(patch, finding.line)) {
      inlineComments.push({
        path: finding.file,
        line: finding.line,
        side: "RIGHT",
        body: formatInlineComment(finding),
      });
    } else {
      tableFindings.push(finding);
    }
  }

  const body = [
    `**Actionable comments posted: ${inlineComments.length}**`,
    "",
    ...(tableFindings.length > 0
      ? [
          "## Other findings",
          "",
          "| Severity | File:Line | Finding | Suggestion |",
          "|---|---|---|---|",
          ...tableFindings.map(
            (f) =>
              `| ${severityLabel(f)} | ${f.file}:${f.line} | ${f.finding} | ${f.suggestion ?? "-"} |`,
          ),
        ]
      : []),
    "",
    "> [KITTEN-TEST]",
  ].join("\n");

  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) {
    throw new Error(`Invalid repo format for PR review — expected 'owner/repo', got '${repo}'`);
  }

  const octokit = new Octokit({ auth: token });

  // Without `event` the review is created PENDING — never submitted, and its
  // inline comments stay invisible until someone submits it. There is no
  // `state` field on this endpoint; the request body accepts only commit_id,
  // body, event and comments.
  const submit = (event: ReviewEvent, reviewBody: string) =>
    octokit.pulls.createReview({
      owner,
      repo: repoName,
      pull_number: prNumber,
      event,
      body: reviewBody,
      comments: inlineComments,
    });

  const counts = { postedInline: inlineComments.length, inTable: tableFindings.length };
  const requested: ReviewEvent = blocking === "request_changes" ? "REQUEST_CHANGES" : "COMMENT";

  try {
    await submit(requested, body);
    return { ...counts, event: requested, downgraded: false };
  } catch (error) {
    // Retrying as a plain comment is self-validating: a 422 caused by anything
    // other than the self-review rule (bad anchor, missing body) fails again on
    // the retry and propagates. Matching GitHub's error prose instead would
    // break the moment they reword it.
    if (requested !== "REQUEST_CHANGES" || !isUnprocessable(error)) {
      throw error;
    }

    console.warn("[reviewer] REQUEST_CHANGES rejected (422) — posting the review as a comment");
    await submit("COMMENT", `${body}\n\n${DOWNGRADE_NOTE}`);
    return { ...counts, event: "COMMENT", downgraded: true };
  }
}

function isUnprocessable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 422
  );
}

function formatInlineComment(finding: Finding): string {
  return [
    `:warning: **${severityLabel(finding)}** — ${finding.finding}`,
    ...(finding.suggestion ? [`\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\``] : []),
  ].join("\n");
}

/**
 * Severity, plus the rule that produced the finding when one is attributed
 * (KIT-018, US-018 AC-4). Shared by the inline comment and the table row so
 * both surfaces name the rule the same way. Attribution is already validated
 * against `.reviewer.yml` during consolidation, so whatever arrives here is a
 * declared id.
 */
function severityLabel(finding: Finding): string {
  return finding.ruleId ? `${finding.severity} (${finding.ruleId})` : finding.severity;
}
