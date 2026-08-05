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
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});

/**
 * git_blame — per-line authorship for a line range, root-confined and capped
 * by MCPConfig.gitBlame.maxLines. Output: line<TAB>hash<TAB>author<TAB>date<TAB>text.
 * endLine beyond EOF is clamped, not an error (agentic callers guess ranges).
 * Parses `git blame --porcelain`, where author headers appear only the first
 * time a commit is seen — hence the per-hash metadata cache below.
 */
export const gitBlameTool: McpTool = {
  name: "git_blame",
  description:
    "Blame a line range of a file. Each line: line<TAB>hash<TAB>author<TAB>date<TAB>text. " +
    "Use to see who last touched a line and when.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Repository-relative file path" },
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
    },
    required: ["path", "startLine", "endLine"],
  },
  async execute(input: unknown, ctx: McpContext): Promise<McpToolResult> {
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      return toolError("VALIDATION", `Invalid git_blame input: ${parsed.error.issues[0]?.message ?? "bad shape"}`);
    }
    const { startLine, endLine } = parsed.data;
    if (startLine > endLine) {
      return toolError("VALIDATION", `startLine (${startLine}) must not exceed endLine (${endLine})`);
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

    const totalLines = fs.readFileSync(absolute, "utf-8").split("\n").length;
    const clampedEnd = Math.min(endLine, totalLines);
    const clampedStart = Math.min(startLine, clampedEnd);

    const git = simpleGit(fs.realpathSync(ctx.cloneDir));
    let raw: string;
    try {
      raw = await git.raw(["blame", "--porcelain", "-L", `${clampedStart},${clampedEnd}`, "--", relative]);
    } catch (error) {
      return toolError("NOT_FOUND", `git blame failed for ${parsed.data.path}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const rows = parsePorcelain(raw);
    const { maxLines } = ctx.caps.gitBlame;
    const truncated = rows.length > maxLines;
    return { content: rows.slice(0, maxLines).join("\n"), truncated };
  },
};

interface CommitMeta {
  readonly author: string;
  readonly date: string;
}

function parsePorcelain(raw: string): string[] {
  const metaByHash = new Map<string, CommitMeta>();
  const rows: string[] = [];
  let currentHash = "";
  let currentLine = 0;
  let author = "";
  let date = "";

  for (const line of raw.split("\n")) {
    if (/^[0-9a-f]{40} \d+ \d+/.test(line)) {
      const [hash, , finalLine] = line.split(" ");
      currentHash = hash ?? "";
      currentLine = Number(finalLine);
      const cached = metaByHash.get(currentHash);
      author = cached?.author ?? "";
      date = cached?.date ?? "";
    } else if (line.startsWith("author ")) {
      author = line.slice("author ".length);
    } else if (line.startsWith("author-time ")) {
      date = new Date(Number(line.slice("author-time ".length)) * 1000).toISOString();
    } else if (line.startsWith("\t")) {
      metaByHash.set(currentHash, { author, date });
      rows.push(`${currentLine}\t${currentHash.slice(0, 12)}\t${author}\t${date}\t${line.slice(1)}`);
    }
  }
  return rows;
}
