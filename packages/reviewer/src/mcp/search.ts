import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { z } from "zod";
import picomatch from "picomatch";

import { isExcluded } from "./confinement.js";
import { toolError } from "./registry.js";
import type { McpContext, McpTool, McpToolResult } from "./registry.js";

const MAX_QUERY_LENGTH = 500;
/** Per-search wall-clock budget. Catastrophic backtracking inside a single
 * regex evaluation is uninterruptible from plain JS — matching runs inside a
 * vm.Script with `timeout`, which V8 can interrupt mid-regex. */
const SEARCH_TIMEOUT_MS = 2_000;

const InputSchema = z.strictObject({
  query: z.string().min(1),
  pathGlob: z.string().min(1).optional(),
  caseSensitive: z.boolean().optional(),
});

// Compiled once; per-file matching evaluates the regex inside a timed-out vm.
const MATCH_SCRIPT = new vm.Script(
  "(() => { const out = []; const re = new RegExp(source, flags);" +
    " for (let i = 0; i < lines.length; i += 1) { re.lastIndex = 0; if (re.test(lines[i])) out.push(i); }" +
    " return out; })()",
);

/**
 * search — regex over the clone tree, honoring skip patterns + `.git`
 * exclusion, capped by MCPConfig.search (maxResults, contextLines,
 * caseSensitive). Lexical in-process walk: the reviewer image has no rg,
 * and a JS walk keeps the tool vitest-testable (KIT-024 decision 1).
 */
export const searchTool: McpTool = {
  name: "search",
  description:
    "Regex search over the repository tree. Returns file:line matches with context lines. " +
    "Optionally narrow with pathGlob (picomatch) and caseSensitive.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Regular expression to search for" },
      pathGlob: { type: "string", description: "Glob restricting which files are searched" },
      caseSensitive: { type: "boolean" },
    },
    required: ["query"],
  },
  async execute(input: unknown, ctx: McpContext): Promise<McpToolResult> {
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      return toolError("VALIDATION", `Invalid search input: ${parsed.error.issues[0]?.message ?? "bad shape"}`);
    }
    const { query, pathGlob } = parsed.data;
    if (query.length > MAX_QUERY_LENGTH) {
      return toolError("VALIDATION", `Query too long (max ${MAX_QUERY_LENGTH} chars)`);
    }

    const caseSensitive = parsed.data.caseSensitive ?? ctx.caps.search.caseSensitive;
    const flags = caseSensitive ? "g" : "gi";
    try {
      new RegExp(query, flags);
    } catch (error) {
      return toolError("VALIDATION", `Invalid regex: ${error instanceof Error ? error.message : String(error)}`);
    }

    const globMatch = pathGlob ? picomatch(pathGlob, { dot: true }) : undefined;
    const { maxResults, contextLines } = ctx.caps.search;
    const deadline = Date.now() + SEARCH_TIMEOUT_MS;
    const matches: string[] = [];
    let truncated = false;

    try {
      walk(ctx.cloneDir, "", (relPath, absolute) => {
        if (matches.length >= maxResults) {
          truncated = true;
          return false;
        }
        if (globMatch && !globMatch(relPath)) return true;

        const stat = fs.statSync(absolute);
        if (stat.size > ctx.caps.read.maxFileBytes) return true; // binary/large: skip, don't partially match
        const raw = fs.readFileSync(absolute, "utf-8");
        if (raw.includes(String.fromCharCode(0))) return true; // binary: skip
        const lines = raw.split("\n");

        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new SearchTimeoutError();
        let hits: number[];
        try {
          hits = MATCH_SCRIPT.runInNewContext(
            { source: query, flags, lines },
            { timeout: Math.max(1, remaining) },
          ) as number[];
        } catch (error) {
          // The vm timeout error may not be instanceof our realm's Error —
          // match by message instead.
          if (/timed out/i.test(String(error))) throw new SearchTimeoutError();
          throw error;
        }

        for (const lineIndex of hits) {
          if (matches.length >= maxResults) {
            truncated = true;
            return false;
          }
          matches.push(renderMatch(relPath, lines, lineIndex, contextLines));
        }
        return true;
      }, ctx.skipPatterns);
    } catch (error) {
      if (error instanceof SearchTimeoutError) {
        return toolError("VALIDATION", `Search timed out after ${SEARCH_TIMEOUT_MS}ms — simplify the regex`);
      }
      throw error;
    }

    if (matches.length === 0) {
      return { content: "No results found.", truncated: false };
    }
    return { content: matches.join("\n---\n"), truncated };
  },
};

class SearchTimeoutError extends Error {}

/** Depth-first walk; callback returns false to stop the walk entirely. */
function walk(
  root: string,
  relDir: string,
  visit: (relPath: string, absolute: string) => boolean,
  skipPatterns: readonly string[],
): boolean {
  const absoluteDir = path.join(root, relDir);
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (isExcluded(relPath, skipPatterns)) continue;
    if (entry.isSymbolicLink()) continue; // never follow symlinks out of the root
    if (entry.isDirectory()) {
      if (!walk(root, relPath, visit, skipPatterns)) return false;
    } else if (entry.isFile()) {
      if (!visit(relPath, path.join(root, relPath))) return false;
    }
  }
  return true;
}

function renderMatch(
  relPath: string,
  lines: readonly string[],
  lineIndex: number,
  contextLines: number,
): string {
  const start = Math.max(0, lineIndex - contextLines);
  const end = Math.min(lines.length - 1, lineIndex + contextLines);
  const block: string[] = [];
  for (let i = start; i <= end; i += 1) {
    const marker = i === lineIndex ? ":" : "-";
    block.push(`${relPath}${marker}${i + 1}${marker} ${lines[i]}`);
  }
  return block.join("\n");
}
