import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { gitBlameTool } from "../../src/mcp/git-blame.js";
import type { McpContext } from "../../src/mcp/registry.js";
import { DEFAULT_MCP_CONFIG } from "@kitten/shared";

let cloneDir: string;
let ctx: McpContext;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Blame Author",
      GIT_AUTHOR_EMAIL: "blame@example.com",
      GIT_COMMITTER_NAME: "Blame Author",
      GIT_COMMITTER_EMAIL: "blame@example.com",
    },
  });
}

beforeAll(() => {
  cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "kitten-gitblame-"));
  git(cloneDir, "init", "-b", "main");
  fs.writeFileSync(path.join(cloneDir, "code.ts"), "alpha\nbeta\ngamma\n");
  git(cloneDir, "add", ".");
  git(cloneDir, "commit", "-m", "add code");
  ctx = { cloneDir, skipPatterns: [], caps: DEFAULT_MCP_CONFIG };
});

afterAll(() => {
  fs.rmSync(cloneDir, { recursive: true, force: true });
});

describe("gitBlameTool", () => {
  it("returns line, hash, author, date and text for the range", async () => {
    const result = await gitBlameTool.execute({ path: "code.ts", startLine: 1, endLine: 2 }, ctx);
    const lines = result.content.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^1\t[0-9a-f]{7,40}\tBlame Author\t\S+\talpha$/);
    expect(lines[1]).toContain("beta");
    expect(result.truncated).toBe(false);
  });

  it("clamps endLine beyond EOF instead of erroring", async () => {
    const result = await gitBlameTool.execute({ path: "code.ts", startLine: 2, endLine: 999 }, ctx);
    const lines = result.content.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("beta");
    expect(lines[1]).toContain("gamma");
    expect(result.content).not.toContain('"code"');
  });

  it("caps returned lines at maxLines with truncated flag", async () => {
    const capped: McpContext = {
      ...ctx,
      caps: { ...DEFAULT_MCP_CONFIG, gitBlame: { maxLines: 1 } },
    };
    const result = await gitBlameTool.execute({ path: "code.ts", startLine: 1, endLine: 3 }, capped);
    expect(result.content.split("\n")).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("path escaping the root → VALIDATION", async () => {
    const result = await gitBlameTool.execute({ path: "../../etc/passwd", startLine: 1, endLine: 2 }, ctx);
    expect(result.content).toContain('"code": "VALIDATION"');
  });

  it("nonexistent file → NOT_FOUND", async () => {
    const result = await gitBlameTool.execute({ path: "missing.ts", startLine: 1, endLine: 2 }, ctx);
    expect(result.content).toContain('"code": "NOT_FOUND"');
  });

  it("startLine greater than endLine → VALIDATION", async () => {
    const result = await gitBlameTool.execute({ path: "code.ts", startLine: 5, endLine: 2 }, ctx);
    expect(result.content).toContain('"code": "VALIDATION"');
  });
});
