import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AppError } from "@kitten/shared";

import { confinePath, isExcluded } from "./confinement.js";
import { toolError } from "./registry.js";
import type { McpContext, McpTool, McpToolResult } from "./registry.js";

const InputSchema = z.strictObject({
  path: z.string().min(1),
});

/**
 * list_directory — one-level entries (name + dir flag), root-confined,
 * capped by MCPConfig.listDirectory.maxEntries. No recursion: the model
 * recurses by calling again (that is what the turn budget is for).
 */
export const listDirectoryTool: McpTool = {
  name: "list_directory",
  description:
    "List the immediate entries of a repository directory. Directories end with '/'. " +
    "Use '.' for the repository root.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Repository-relative directory path ('.' for root)" },
    },
    required: ["path"],
  },
  async execute(input: unknown, ctx: McpContext): Promise<McpToolResult> {
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      return toolError("VALIDATION", `Invalid list_directory input: ${parsed.error.issues[0]?.message ?? "bad shape"}`);
    }

    let absolute: string;
    try {
      absolute = confinePath(ctx.cloneDir, parsed.data.path);
    } catch (error) {
      return toolError("VALIDATION", error instanceof AppError ? error.message : String(error));
    }

    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
      return toolError("NOT_FOUND", `Directory not found: ${parsed.data.path}`);
    }

    const relDir = path.relative(ctx.cloneDir, absolute);
    const { maxEntries } = ctx.caps.listDirectory;
    const entries = fs
      .readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => {
        const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
        return !isExcluded(relPath, ctx.skipPatterns);
      })
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();

    const truncated = entries.length > maxEntries;
    const content = entries.slice(0, maxEntries).join("\n");
    return { content: content || "(empty directory)", truncated };
  },
};
