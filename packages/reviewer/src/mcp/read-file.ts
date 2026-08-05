import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AppError } from "@kitten/shared";

import { confinePath, isExcluded, capContent } from "./confinement.js";
import { toolError } from "./registry.js";
import type { McpContext, McpTool, McpToolResult } from "./registry.js";

const InputSchema = z.strictObject({
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});

/**
 * read_file — numbered lines from a clone-dir file, root-confined and capped
 * by MCPConfig.read (maxLines / maxFileBytes).
 */
export const readFileTool: McpTool = {
  name: "read_file",
  description:
    "Read a file from the repository. Returns numbered lines. " +
    "Optionally pass startLine/endLine (1-based, inclusive) to read a range.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Repository-relative file path" },
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
    },
    required: ["path"],
  },
  async execute(input: unknown, ctx: McpContext): Promise<McpToolResult> {
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      return toolError("VALIDATION", `Invalid read_file input: ${parsed.error.issues[0]?.message ?? "bad shape"}`);
    }

    let absolute: string;
    try {
      absolute = confinePath(ctx.cloneDir, parsed.data.path);
    } catch (error) {
      return toolError("VALIDATION", error instanceof AppError ? error.message : String(error));
    }

    const relative = path.relative(ctx.cloneDir, absolute);
    if (isExcluded(relative, ctx.skipPatterns)) {
      return toolError("VALIDATION", `Path is excluded from review: ${relative}`);
    }

    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      return toolError("NOT_FOUND", `File not found: ${parsed.data.path}`);
    }

    const { maxLines, maxFileBytes } = ctx.caps.read;
    const raw = fs.readFileSync(absolute, "utf-8");
    const lines = raw.split("\n");

    const start = parsed.data.startLine ?? 1;
    const end = Math.min(parsed.data.endLine ?? lines.length, lines.length);
    const window = lines.slice(start - 1, end);
    const lineCapped = window.length > maxLines;
    const numbered = window
      .slice(0, maxLines)
      .map((line, index) => `${start + index}\t${line}`)
      .join("\n");

    const byteCapped = capContent(numbered, maxFileBytes);
    return { content: byteCapped.content, truncated: lineCapped || byteCapped.truncated };
  },
};
