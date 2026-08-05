import fs from "node:fs";
import { z } from "zod";
import { AppError } from "@kitten/shared";

import { confinePath } from "./confinement.js";
import { searchTool } from "./search.js";
import { toolError } from "./registry.js";
import type { McpContext, McpTool, McpToolResult } from "./registry.js";

const InputSchema = z.strictObject({
  file: z.string().min(1),
  line: z.number().int().positive(),
});

/** JS/TS reserved words — best-effort filter (KIT-025 decision 1). */
const KEYWORDS = new Set([
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
  "throw", "try", "catch", "finally", "new", "this", "super", "typeof",
  "instanceof", "void", "delete", "in", "of", "async", "await", "yield",
  "true", "false", "null", "undefined", "type", "interface", "enum",
  "implements", "extends", "static", "public", "private", "protected",
  "readonly", "abstract", "default", "as", "from", "get", "set",
]);

/**
 * find_related — extract the identifier at file:line, then reuse the search
 * tool for repo-wide occurrences (call-site analysis primitive). Symbol/
 * usage-based, not semantic (Semble is v7 Deep Context).
 */
export const findRelatedTool: McpTool = {
  name: "find_related",
  description:
    "Find repo-wide occurrences (call sites, usages) of the identifier at a given file:line. " +
    "Returns the extracted identifier and each occurrence with a short snippet.",
  inputSchema: {
    type: "object",
    properties: {
      file: { type: "string", description: "Repository-relative file path" },
      line: { type: "integer", minimum: 1, description: "1-based line number" },
    },
    required: ["file", "line"],
  },
  async execute(input: unknown, ctx: McpContext): Promise<McpToolResult> {
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      return toolError("VALIDATION", `Invalid find_related input: ${parsed.error.issues[0]?.message ?? "bad shape"}`);
    }

    let absolute: string;
    try {
      absolute = confinePath(ctx.cloneDir, parsed.data.file);
    } catch (error) {
      return toolError("VALIDATION", error instanceof AppError ? error.message : String(error));
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      return toolError("NOT_FOUND", `File not found: ${parsed.data.file}`);
    }

    const lines = fs.readFileSync(absolute, "utf-8").split("\n");
    const targetLine = lines[parsed.data.line - 1];
    const identifier = targetLine === undefined ? undefined : extractIdentifier(targetLine);
    if (!identifier) {
      return {
        content: `No identifier found at ${parsed.data.file}:${parsed.data.line}. Try a different line or use search directly.`,
        truncated: false,
      };
    }

    // Reuse the search tool with the findRelated result cap.
    const searchCtx: McpContext = {
      ...ctx,
      caps: {
        ...ctx.caps,
        search: { ...ctx.caps.search, maxResults: ctx.caps.findRelated.maxResults },
      },
    };
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const occurrences = await searchTool.execute(
      { query: `\\b${escaped}\\b`, caseSensitive: true },
      searchCtx,
    );

    // A truncated result may have been cut before reaching other files —
    // only claim "no other occurrences" on a complete search.
    if (
      occurrences.content.includes("No results") ||
      (!occurrences.truncated && onlyTargetFile(occurrences.content, parsed.data.file))
    ) {
      return {
        content: `Identifier "${identifier}" has no other occurrences in the repository.`,
        truncated: false,
      };
    }

    return {
      content: `Identifier "${identifier}" — occurrences:\n${occurrences.content}`,
      truncated: occurrences.truncated,
    };
  },
};

/**
 * Longest non-keyword, non-numeric token; ties → leftmost (KIT-025
 * decision 1). Returns undefined when nothing qualifies.
 */
function extractIdentifier(line: string): string | undefined {
  const tokens = line.match(/[a-zA-Z0-9_]+/g) ?? [];
  let best: string | undefined;
  for (const token of tokens) {
    if (!/[a-zA-Z]/.test(token)) continue; // numeric literal
    if (KEYWORDS.has(token)) continue;
    if (best === undefined || token.length > best.length) best = token;
  }
  return best;
}

/** True when every occurrence line references only the queried file itself. */
function onlyTargetFile(content: string, file: string): boolean {
  const files = new Set(
    [...content.matchAll(/^(.+?)[:-]\d+[:-]/gm)].map((match) => match[1]),
  );
  return files.size === 1 && files.has(file);
}
