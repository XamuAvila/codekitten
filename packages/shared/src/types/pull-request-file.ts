/**
 * PullRequestFile — camelCase mirror of the GitHub API response
 * for a file in a pull request (pulls.listFiles).
 */
export interface PullRequestFile {
  readonly filename: string;
  readonly status: "added" | "modified" | "removed" | "renamed";
  readonly patch?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly blobUrl: string;
  readonly rawUrl: string;
}
