import { simpleGit } from "simple-git";
import { AppError } from "@kitten/shared";
import fs from "node:fs";

import type { CloneResult } from "../types.js";

/**
 * Full clone (all refs — v2 decision, git_log/diff need history) with the PR
 * head branch checked out (KIT-041: everything read from the worktree —
 * .reviewer.yml, .reviewer-mcp.json, conventions, agentic tools — must see
 * the head, not the default branch). Token-authenticated HTTPS; the token is
 * NEVER logged — all error paths sanitize the URL.
 * Throws AppError(NOT_FOUND) when the clone fails.
 */
export async function cloneRepo(
  repo: string,
  branch: string,
  destDir: string,
  token: string,
): Promise<CloneResult> {
  const authUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
  const sanitizedUrl = `https://x-access-token:***@github.com/${repo}.git`;

  try {
    const git = simpleGit();
    await git.clone(authUrl, destDir, ["--branch", branch]);
  } catch (error: unknown) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    // Sanitize: replace any occurrence of the token in the error message
    const safeMessage = rawMessage.replaceAll(token, "***");

    throw new AppError(
      "NOT_FOUND",
      "Repository not found or inaccessible",
      [{ repo, branch, url: sanitizedUrl, detail: safeMessage }],
    );
  }

  const sizeBytes = estimateDirSize(destDir);
  return { dir: destDir, sizeBytes };
}

function estimateDirSize(dir: string): number {
  let total = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        total += estimateDirSize(full);
      } else if (entry.isFile()) {
        total += fs.statSync(full).size;
      }
    }
  } catch {
    // best-effort estimation
  }
  return total;
}
