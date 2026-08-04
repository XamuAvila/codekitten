import { Octokit } from "@octokit/rest";
import type { Finding } from "@kitten/shared";

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
 */
export async function postPrReview(
  token: string,
  repo: string,
  prNumber: number,
  findings: readonly Finding[],
  filePatches: ReadonlyMap<string, string>,
): Promise<{ postedInline: number; inTable: number }> {
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
  await octokit.pulls.createReview({
    owner,
    repo: repoName,
    pull_number: prNumber,
    state: "COMMENTED",
    // Without `event` the review is created PENDING — never submitted, and
    // its inline comments stay invisible until someone submits it.
    event: "COMMENT",
    body,
    comments: inlineComments,
  });

  return { postedInline: inlineComments.length, inTable: tableFindings.length };
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
