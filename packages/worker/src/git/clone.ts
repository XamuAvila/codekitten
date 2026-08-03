import { simpleGit } from "simple-git";
import { AppError } from "@kitten/shared";
import fs from "node:fs";

export interface CloneResult {
  readonly dir: string;
  readonly sizeBytes: number;
}

/**
 * Clones a repository with --depth=1 into a temporary directory.
 * Returns CloneResult with the directory path and approximate size.
 * Throws AppError(NOT_FOUND) when the clone fails (repo inaccessible, etc.).
 */
export async function cloneRepo(
  repo: string,
  branch: string,
  destDir: string,
): Promise<CloneResult> {
  const url = `https://github.com/${repo}.git`;

  try {
    const git = simpleGit();
    await git.clone(url, destDir, {
      "--depth": "1",
      "--branch": branch,
    });
  } catch (error: unknown) {
    throw new AppError(
      "NOT_FOUND",
      "Repository not found or inaccessible",
      [{ repo, branch, detail: error instanceof Error ? error.message : String(error) }],
    );
  }

  const sizeBytes = await estimateDirSize(destDir);
  return { dir: destDir, sizeBytes };
}

async function estimateDirSize(dir: string): Promise<number> {
  let total = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        total += await estimateDirSize(full);
      } else if (entry.isFile()) {
        total += fs.statSync(full).size;
      }
    }
  } catch {
    // best-effort estimation
  }
  return total;
}
