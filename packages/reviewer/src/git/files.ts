import { Octokit } from "@octokit/rest";
import picomatch from "picomatch";
import { AppError } from "@kitten/shared";
import type { PullRequestFile } from "@kitten/shared";

/**
 * Fetches PR files from the GitHub API, maps snake_case response to
 * camelCase PullRequestFile, and filters out files matching skip patterns.
 * Token is used for Octokit auth — never logged.
 * Throws AppError(AUTH_FAILED) on 401/403 responses.
 */
export async function fetchPrFiles(
  repo: string,
  prNumber: number,
  token: string,
  skipPatterns: readonly string[],
): Promise<readonly PullRequestFile[]> {
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) {
    throw new AppError(
      "VALIDATION",
      "Invalid repo format — expected 'owner/repo'",
      [{ repo }],
    );
  }

  const octokit = new Octokit({ auth: token });

  let response;
  try {
    response = await octokit.pulls.listFiles({
      owner,
      repo: repoName,
      pull_number: prNumber,
      per_page: 100,
    });
  } catch (error: unknown) {
    const status = isOctokitError(error) ? error.status : undefined;
    if (status === 401 || status === 403) {
      throw new AppError(
        "AUTH_FAILED",
        "GitHub authentication failed — token may be invalid or expired",
        [{ repo, prNumber, status }],
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError(
      "NOT_FOUND",
      "Failed to fetch PR files from GitHub",
      [{ repo, prNumber, detail: message }],
    );
  }

  if (response.data.length >= 3000) {
    console.warn(
      `[reviewer] Warning: PR #${prNumber} has ${response.data.length} files (API limit 3000) — results may be truncated`,
    );
  }

  const allFiles = response.data.map(mapToPullRequestFile);

  if (skipPatterns.length === 0) {
    return allFiles;
  }

  const isSkipped = picomatch(skipPatterns as string[], { dot: true });
  return allFiles.filter((file) => !isSkipped(file.filename));
}

interface OctokitError {
  readonly status: number;
  readonly message: string;
}

function isOctokitError(error: unknown): error is OctokitError {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as OctokitError).status === "number"
  );
}

/**
 * Maps GitHub API response (snake_case) to camelCase PullRequestFile.
 * Status values from the API: "added", "removed", "modified", "renamed",
 * "copied", "changed", "unchanged". We map to our narrower union.
 */
function mapToPullRequestFile(apiFile: {
  readonly filename: string;
  readonly status: string;
  readonly patch?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly blob_url: string;
  readonly raw_url: string;
}): PullRequestFile {
  return {
    filename: apiFile.filename,
    status: normalizeStatus(apiFile.status),
    patch: apiFile.patch,
    additions: apiFile.additions,
    deletions: apiFile.deletions,
    changes: apiFile.changes,
    blobUrl: apiFile.blob_url,
    rawUrl: apiFile.raw_url,
  };
}

function normalizeStatus(
  status: string,
): PullRequestFile["status"] {
  switch (status) {
    case "added":
    case "modified":
    case "removed":
    case "renamed":
      return status;
    default:
      // "copied", "changed", "unchanged" → treat as "modified"
      return "modified";
  }
}
