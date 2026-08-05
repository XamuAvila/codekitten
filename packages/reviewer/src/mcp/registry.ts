import type { MCPConfig, McpToolName } from "@kitten/shared";

/**
 * McpTool registry — the v4 read-only tool layer. In-process TypeScript
 * executors, no external server; a future Semble integration would implement
 * the same McpTool interface and register here (swap point, epic D1).
 * Read-only by construction: no write tools exist in this layer.
 */

export interface McpContext {
  readonly cloneDir: string;
  /** ReviewerConfig.skip + MCPConfig.search.skip — never read/searched. */
  readonly skipPatterns: readonly string[];
  readonly caps: MCPConfig;
}

export interface McpToolResult {
  /** Text fed back to the model as tool_result. */
  readonly content: string;
  readonly truncated: boolean;
}

export interface McpTool {
  readonly name: McpToolName;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  execute(input: unknown, ctx: McpContext): Promise<McpToolResult>;
}

export interface McpRegistry {
  readonly ctx: McpContext;
  get(name: McpToolName): McpTool | undefined;
  list(): readonly McpTool[];
}

import { readFileTool } from "./read-file.js";
import { searchTool } from "./search.js";

export function createRegistry(
  cloneDir: string,
  skipPatterns: readonly string[],
  caps: MCPConfig,
): McpRegistry {
  const ctx: McpContext = { cloneDir, skipPatterns, caps };
  const tools = new Map<McpToolName, McpTool>(
    [readFileTool, searchTool].filter((tool) => caps.tools.includes(tool.name)).map((tool) => [tool.name, tool]),
  );
  return {
    ctx,
    get: (name) => tools.get(name),
    list: () => [...tools.values()],
  };
}

/** Renders a structured tool error as tool_result content. */
export function toolError(code: "VALIDATION" | "NOT_FOUND" | "UNKNOWN_TOOL", message: string): McpToolResult {
  return { content: JSON.stringify({ code, message }, null, 1), truncated: false };
}
