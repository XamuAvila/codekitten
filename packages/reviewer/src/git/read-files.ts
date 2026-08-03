import fs from "node:fs";
import path from "node:path";
import { AppError } from "@kitten/shared";
import type { PullRequestFile, ReviewFile } from "@kitten/shared";

/**
 * Reads the full content of each changed file from the clone dir.
 *
 * Security: filenames come from the GitHub API (untrusted input) — the
 * resolved path MUST stay inside the clone dir. Path traversal or absolute
 * paths are rejected with VALIDATION before any read.
 *
 * Files that no longer exist in the clone (removed/renamed in the PR) are
 * skipped — their content is unavailable, and the diff still carries the
 * change.
 */
export async function readChangedFiles(
  cloneDir: string,
  prFiles: readonly PullRequestFile[],
): Promise<readonly ReviewFile[]> {
  const root = path.resolve(cloneDir);
  const files: ReviewFile[] = [];

  for (const prFile of prFiles) {
    const candidate = path.resolve(root, prFile.filename);
    if (candidate !== root && !candidate.startsWith(root + path.sep)) {
      throw new AppError(
        "VALIDATION",
        `File path escapes the clone directory: ${prFile.filename}`,
        [{ filename: prFile.filename }],
      );
    }

    if (!fs.existsSync(candidate)) {
      continue;
    }

    const content = fs.readFileSync(candidate, "utf-8");
    files.push({ path: prFile.filename, content });
  }

  return files;
}
