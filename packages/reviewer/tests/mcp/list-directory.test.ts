import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listDirectoryTool } from "../../src/mcp/list-directory.js";
import type { McpContext } from "../../src/mcp/registry.js";
import { DEFAULT_MCP_CONFIG } from "@kitten/shared";

let cloneDir: string;
let ctx: McpContext;

beforeAll(() => {
  cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "kitten-listdir-"));
  fs.mkdirSync(path.join(cloneDir, "src"));
  fs.mkdirSync(path.join(cloneDir, ".git"));
  fs.writeFileSync(path.join(cloneDir, "README.md"), "# readme\n");
  fs.writeFileSync(path.join(cloneDir, "src", "a.ts"), "const a = 1;\n");
  ctx = { cloneDir, skipPatterns: [], caps: DEFAULT_MCP_CONFIG };
});

afterAll(() => {
  fs.rmSync(cloneDir, { recursive: true, force: true });
});

describe("listDirectoryTool", () => {
  it("lists one-level entries with dir/file flags", async () => {
    const result = await listDirectoryTool.execute({ path: "." }, ctx);
    expect(result.content).toContain("src/");
    expect(result.content).toContain("README.md");
    expect(result.truncated).toBe(false);
  });

  it("never lists .git", async () => {
    const result = await listDirectoryTool.execute({ path: "." }, ctx);
    expect(result.content).not.toContain(".git");
  });

  it("caps at listDirectory.maxEntries with truncated flag", async () => {
    const capped: McpContext = {
      ...ctx,
      caps: { ...DEFAULT_MCP_CONFIG, listDirectory: { maxEntries: 1 } },
    };
    const result = await listDirectoryTool.execute({ path: "." }, capped);
    expect(result.truncated).toBe(true);
  });

  it("missing dir → NOT_FOUND", async () => {
    const result = await listDirectoryTool.execute({ path: "nope" }, ctx);
    expect(result.content).toContain('"code": "NOT_FOUND"');
  });

  it("escape path → VALIDATION", async () => {
    const result = await listDirectoryTool.execute({ path: "../../" }, ctx);
    expect(result.content).toContain('"code": "VALIDATION"');
  });
});
