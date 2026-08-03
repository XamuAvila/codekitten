import { Octokit } from "@octokit/rest";
import { AppError } from "@kitten/shared";
import type { PrMetadata } from "../types.js";

/**
 * Fetch PR metadata (title, author, state) from the GitHub API.
 * Throws AppError on failure — NOT_FOUND for 404, GITHUB_API_ERROR for others.
 * Token is used for Octokit auth — never logged.
 */
export async function fetchPrMetadata(
  token: string,
  repo: string,
  prNumber: number,
): Promise<PrMetadata> {
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) {
    throw new AppError(
      "VALIDATION",
      "Invalid repo format — expected 'owner/repo'",
      [{ repo }],
    );
  }

  const octokit = new Octokit({ auth: token });

  try {
    const response = await octokit.pulls.get({
      owner,
      repo: repoName,
      pull_number: prNumber,
    });

    return {
      title: response.data.title,
      author: response.data.user?.login ?? "unknown",
      state: mapPrState(response.data.state, response.data.merged),
    };
  } catch (error: unknown) {
    const status = isOctokitError(error) ? error.status : undefined;
    if (status === 404) {
      throw new AppError(
        "NOT_FOUND",
        `PR #${prNumber} not found in ${repo}`,
        [{ repo, prNumber, status }],
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError(
      "GITHUB_API_ERROR",
      `Failed to fetch PR metadata: ${message}`,
      [{ repo, prNumber, status }],
    );
  }
}

/**
 * Maps GitHub API PR state + merged flag to our narrower union.
 * GitHub returns state as "open" | "closed", with a separate `merged` boolean.
 */
function mapPrState(
  state: string,
  merged: boolean | null,
): PrMetadata["state"] {
  if (merged) return "merged";
  if (state === "open") return "open";
  return "closed";
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
