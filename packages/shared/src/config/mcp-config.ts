import { z } from "zod";

import { AppError } from "../types/index.js";

/**
 * MCPConfig — parsed from `.reviewer-mcp.json` at the clone root (v4 agentic
 * review opt-in). Additive to `.reviewer.yml`: it only widens/narrows tool
 * behavior, never provider/model/blocking/language.
 *
 * Missing file → callers use DEFAULT_MCP_CONFIG (enabled: false → v3 path).
 * Invalid content throws VALIDATION; the pipeline fail-safes to monolithic.
 */

export const McpToolNameSchema = z.enum([
  "read_file",
  "search",
  "find_related",
  "list_directory",
  "git_log",
  "git_blame",
]);
export type McpToolName = z.infer<typeof McpToolNameSchema>;

// strictObject at every level: unknown keys must fail with VALIDATION, not be
// silently stripped — same rationale as RawReviewerSchema in parse-config.ts.
const MCPConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  tools: z
    .array(McpToolNameSchema)
    .readonly()
    .default(["read_file", "search", "find_related", "list_directory", "git_log", "git_blame"]),
  maxTurns: z.number().int().positive().default(12),
  forceMaxTurns: z.number().int().positive().default(60),
  read: z
    .strictObject({
      maxLines: z.number().int().positive().default(200),
      maxFileBytes: z.number().int().positive().default(262_144),
    })
    .default({ maxLines: 200, maxFileBytes: 262_144 }),
  search: z
    .strictObject({
      maxResults: z.number().int().positive().default(30),
      contextLines: z.number().int().nonnegative().default(2),
      caseSensitive: z.boolean().default(false),
      skip: z.array(z.string()).readonly().default([]),
    })
    .default({ maxResults: 30, contextLines: 2, caseSensitive: false, skip: [] }),
  findRelated: z
    .strictObject({ maxResults: z.number().int().positive().default(20) })
    .default({ maxResults: 20 }),
  listDirectory: z
    .strictObject({ maxEntries: z.number().int().positive().default(100) })
    .default({ maxEntries: 100 }),
  gitLog: z
    .strictObject({ maxCommits: z.number().int().positive().default(20) })
    .default({ maxCommits: 20 }),
  gitBlame: z
    .strictObject({ maxLines: z.number().int().positive().default(200) })
    .default({ maxLines: 200 }),
});

export type MCPConfig = z.infer<typeof MCPConfigSchema>;

export const DEFAULT_MCP_CONFIG: MCPConfig = MCPConfigSchema.parse({});

/**
 * Parses `.reviewer-mcp.json` content into an MCPConfig.
 * Empty content returns DEFAULT_MCP_CONFIG. Invalid JSON or schema
 * violations (including unknown keys) throw AppError VALIDATION.
 */
export function parseMcpConfig(jsonContent: string): MCPConfig {
  if (jsonContent.trim() === "") {
    return DEFAULT_MCP_CONFIG;
  }

  let document: unknown;
  try {
    document = JSON.parse(jsonContent);
  } catch (error) {
    throw new AppError("VALIDATION", "Invalid JSON in .reviewer-mcp.json", [
      { message: error instanceof Error ? error.message : String(error) },
    ]);
  }

  const result = MCPConfigSchema.safeParse(document);
  if (!result.success) {
    throw new AppError(
      "VALIDATION",
      "Invalid .reviewer-mcp.json schema",
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    );
  }
  return result.data;
}
