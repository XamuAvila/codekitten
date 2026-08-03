import fs from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";
import type { ReviewerConfig } from "@kitten/shared";

export interface FileContent {
  readonly path: string;
  readonly content: string;
  readonly sizeBytes: number;
}

export interface FileCount {
  readonly total: number;
  readonly filtered: number;
  readonly skipped: number;
}

/**
 * Reads the full content of each file in changedPaths that does NOT match
 * any skip pattern. Returns FileContent objects with path, content, and size.
 */
export async function readChangedFiles(
  repoDir: string,
  changedPaths: readonly string[],
  config: ReviewerConfig,
): Promise<readonly FileContent[]> {
  const patterns = config.skip;
  const filtered = changedPaths.filter((p) => {
    const relative = p.startsWith(repoDir) ? p.slice(repoDir.length + 1) : p;
    return !patterns.some((pattern) => minimatch(relative, pattern, { dot: true }));
  });

  return filtered.map((filePath) => {
    const fullPath = filePath.startsWith(repoDir) ? filePath : path.join(repoDir, filePath);
    const content = fs.readFileSync(fullPath, "utf-8");
    const sizeBytes = fs.statSync(fullPath).size;
    return { path: filePath, content, sizeBytes };
  });
}

/**
 * Walks a directory and counts files, applying skip patterns.
 * Used for v1 when changedFiles is absent from the job payload.
 */
export function countRepoFiles(
  repoDir: string,
  config?: ReviewerConfig,
): FileCount {
  const total = recurseCount(repoDir, repoDir);
  const skipped = config ? recurseCountSkipped(repoDir, repoDir, config) : 0;
  return { total, filtered: total - skipped, skipped };
}

function recurseCount(dir: string, root: string): number {
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        count += recurseCount(full, root);
      } else if (entry.isFile()) {
        count++;
      }
    }
  } catch {
    // skip unreadable dirs
  }
  return count;
}

function recurseCountSkipped(dir: string, root: string, config: ReviewerConfig): number {
  const patterns = config.skip;
  let skipped = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        skipped += recurseCountSkipped(full, root, config);
      } else if (entry.isFile()) {
        const relative = path.relative(root, full);
        if (patterns.some((pattern) => minimatch(relative, pattern, { dot: true }))) skipped++;
      }
    }
  } catch {
    // skip
  }
  return skipped;
}
