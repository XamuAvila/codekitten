import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { AppError } from "@kitten/shared";

/**
 * Root confinement for the v4 read-only tool layer (invariant 1 enforced at
 * the executor boundary). Every tool resolves paths through confinePath —
 * nothing in the mcp/ layer touches the filesystem outside the clone dir.
 */

/**
 * Resolves `requestedPath` against `cloneDir` and asserts the result stays
 * inside it. Rejects `../` traversal, absolute paths outside the root, and
 * symlinks inside the clone pointing outside (realpath on the nearest
 * existing ancestor). Throws AppError VALIDATION on escape.
 */
export function confinePath(cloneDir: string, requestedPath: string): string {
  const root = fs.realpathSync(cloneDir);
  const resolved = path.resolve(root, requestedPath);

  if (!isInside(root, resolved)) {
    throw escapeError(requestedPath);
  }

  // Symlink check: realpath the nearest existing ancestor of the resolved
  // path (the file itself may not exist — read_file reports NOT_FOUND later).
  let probe = resolved;
  while (!fs.existsSync(probe)) {
    probe = path.dirname(probe);
  }
  const real = fs.realpathSync(probe);
  if (!isInside(root, real)) {
    throw escapeError(requestedPath);
  }

  return resolved;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function escapeError(requestedPath: string): AppError {
  return new AppError("VALIDATION", "Path escapes the repository root", [
    { path: requestedPath },
  ]);
}

/**
 * True when `relPath` must never be read/searched: `.git/` always, plus the
 * repo skip patterns (ReviewerConfig.skip + MCPConfig.search.skip).
 */
export function isExcluded(relPath: string, skipPatterns: readonly string[]): boolean {
  if (relPath === ".git" || relPath.startsWith(".git/")) {
    return true;
  }
  return skipPatterns.some((pattern) => picomatch.isMatch(relPath, pattern));
}

/**
 * Caps content at `maxBytes`, flagging truncation.
 */
export function capContent(content: string, maxBytes: number): { content: string; truncated: boolean } {
  if (Buffer.byteLength(content, "utf-8") <= maxBytes) {
    return { content, truncated: false };
  }
  return { content: Buffer.from(content, "utf-8").subarray(0, maxBytes).toString("utf-8"), truncated: true };
}
