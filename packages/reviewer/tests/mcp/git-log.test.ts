import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { gitLogTool } from "../../src/mcp/git-log.js";
import type { McpContext } from "../../src/mcp/registry.js";
import { DEFAULT_MCP_CONFIG } from "@kitten/shared";

let cloneDir: string;
let ctx: McpContext;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture Author",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture Author",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  });
}

beforeAll(() => {
  cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "kitten-gitlog-"));
  git(cloneDir, "init", "-b", "main");
  fs.writeFileSync(path.join(cloneDir, "app.ts"), "one\n");
  git(cloneDir, "add", ".");
  git(cloneDir, "commit", "-m", "first commit");
  fs.writeFileSync(path.join(cloneDir, "app.ts"), "one\ntwo\n");
  git(cloneDir, "add", ".");
  git(cloneDir, "commit", "-m", "second commit");
  fs.writeFileSync(path.join(cloneDir, "untracked.ts"), "never committed\n");
  ctx = { cloneDir, skipPatterns: ["**/node_modules/**"], caps: DEFAULT_MCP_CONFIG };
});

afterAll(() => {
  fs.rmSync(cloneDir, { recursive: true, force: true });
});

describe("gitLogTool", () => {
  it("returns hash, author, date and subject per commit, newest first", async () => {
    const result = await gitLogTool.execute({ path: "app.ts" }, ctx);
    const lines = result.content.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("second commit");
    expect(lines[1]).toContain("first commit");
    expect(lines[0]).toContain("Fixture Author");
    expect(lines[0]).toMatch(/^[0-9a-f]{7,40}\t/);
    expect(result.truncated).toBe(false);
  });

  it("caps commits at maxCommits with truncated flag", async () => {
    const capped: McpContext = {
      ...ctx,
      caps: { ...DEFAULT_MCP_CONFIG, gitLog: { maxCommits: 1 } },
    };
    const result = await gitLogTool.execute({ path: "app.ts" }, capped);
    expect(result.content.split("\n")).toHaveLength(1);
    expect(result.content).toContain("second commit");
    expect(result.truncated).toBe(true);
  });

  it("path escaping the root → VALIDATION", async () => {
    const result = await gitLogTool.execute({ path: "../../etc" }, ctx);
    expect(result.content).toContain('"code": "VALIDATION"');
  });

  it("excluded path → VALIDATION", async () => {
    const result = await gitLogTool.execute({ path: "node_modules/pkg/index.js" }, ctx);
    expect(result.content).toContain('"code": "VALIDATION"');
  });

  it("path with no commits → NOT_FOUND", async () => {
    const result = await gitLogTool.execute({ path: "untracked.ts" }, ctx);
    expect(result.content).toContain('"code": "NOT_FOUND"');
  });

  it("invalid input shape → VALIDATION", async () => {
    const result = await gitLogTool.execute({ nope: true }, ctx);
    expect(result.content).toContain('"code": "VALIDATION"');
  });
});
