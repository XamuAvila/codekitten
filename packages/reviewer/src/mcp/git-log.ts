import fs from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
import { z } from "zod";
import { AppError } from "@kitten/shared";

import { confinePath, isExcluded } from "./confinement.js";
import { toolError } from "./registry.js";
import type { McpContext, McpTool, McpToolResult } from "./registry.js";

const InputSchema = z.strictObject({
  path: z.string().min(1),
});

/**
 * git_log — commit history for a path, root-confined and capped by
 * MCPConfig.gitLog.maxCommits. The clone is full (v2 decision, not shallow),
 * so history is available. Uses simple-git raw commands — same dependency as
 * git/clone.ts, no child_process here.
 */
export const gitLogTool: McpTool = {
  name: "git_log",
  description:
    "Commit history for a repository path, newest first. Each line: " +
    "hash<TAB>author<TAB>date<TAB>subject. Use to judge churn, age and authorship.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Repository-relative file or directory path" },
    },
    required: ["path"],
  },
  async execute(input: unknown, ctx: McpContext): Promise<McpToolResult> {
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      return toolError("VALIDATION", `Invalid git_log input: ${parsed.error.issues[0]?.message ?? "bad shape"}`);
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

    const { maxCommits } = ctx.caps.gitLog;
    const git = simpleGit(fs.realpathSync(ctx.cloneDir));
    let raw: string;
    try {
      // Fetch one extra commit to detect cap overflow (truncated flag).
      raw = await git.raw([
        "log",
        "--follow",
        `-n`,
        String(maxCommits + 1),
        "--format=%h\t%an\t%aI\t%s",
        "--",
        relative,
      ]);
    } catch (error) {
      return toolError("NOT_FOUND", `git log failed for ${parsed.data.path}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) {
      return toolError("NOT_FOUND", `No commit history for path: ${parsed.data.path}`);
    }

    const truncated = lines.length > maxCommits;
    return { content: lines.slice(0, maxCommits).join("\n"), truncated };
  },
};
