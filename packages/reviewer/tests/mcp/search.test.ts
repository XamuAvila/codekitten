import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { searchTool } from "../../src/mcp/search.js";
import type { McpContext } from "../../src/mcp/registry.js";
import { DEFAULT_MCP_CONFIG } from "@kitten/shared";

let cloneDir: string;
let ctx: McpContext;

beforeAll(() => {
  cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "kitten-search-"));
  fs.mkdirSync(path.join(cloneDir, "src"));
  fs.mkdirSync(path.join(cloneDir, "node_modules", "pkg"), { recursive: true });
  fs.mkdirSync(path.join(cloneDir, ".git"));
  fs.writeFileSync(
    path.join(cloneDir, "src", "auth.ts"),
    "function login() {}\nconst token = getToken();\nlogin();\n",
  );
  fs.writeFileSync(path.join(cloneDir, "src", "other.ts"), "export const LOGIN_URL = '/login';\n");
  fs.writeFileSync(path.join(cloneDir, "node_modules", "pkg", "index.js"), "login();\n");
  fs.writeFileSync(path.join(cloneDir, ".git", "config"), "login\n");
  ctx = {
    cloneDir,
    skipPatterns: ["**/node_modules/**"],
    caps: DEFAULT_MCP_CONFIG,
  };
});

afterAll(() => {
  fs.rmSync(cloneDir, { recursive: true, force: true });
});

describe("searchTool", () => {
  it("returns file:line matches with context lines", async () => {
    const result = await searchTool.execute({ query: "getToken" }, ctx);
    expect(result.content).toContain("src/auth.ts:2");
    expect(result.content).toContain("getToken()");
    // contextLines default 2 → neighbors included
    expect(result.content).toContain("function login()");
    expect(result.truncated).toBe(false);
  });

  it("excludes skip patterns and .git", async () => {
    const result = await searchTool.execute({ query: "login" }, ctx);
    expect(result.content).not.toContain("node_modules");
    expect(result.content).not.toContain(".git");
    expect(result.content).toContain("src/auth.ts");
  });

  it("is case-insensitive by default, caseSensitive honored", async () => {
    const insensitive = await searchTool.execute({ query: "LOGIN\\(" }, ctx);
    expect(insensitive.content).toContain("src/auth.ts");

    const sensitive = await searchTool.execute({ query: "LOGIN\\(", caseSensitive: true }, ctx);
    expect(sensitive.content).toContain("No results");
  });

  it("caps results at maxResults with truncated flag", async () => {
    const capped: McpContext = {
      ...ctx,
      caps: { ...DEFAULT_MCP_CONFIG, search: { ...DEFAULT_MCP_CONFIG.search, maxResults: 1 } },
    };
    const result = await searchTool.execute({ query: "login" }, capped);
    expect(result.truncated).toBe(true);
  });

  it("no matches → 'No results' content, not an error", async () => {
    const result = await searchTool.execute({ query: "nonexistent_zzz" }, ctx);
    expect(result.content).toContain("No results");
    expect(result.content).not.toContain('"code"');
  });

  it("malformed regex → VALIDATION", async () => {
    const result = await searchTool.execute({ query: "([unclosed" }, ctx);
    expect(result.content).toContain('"code": "VALIDATION"');
  });

  it("catastrophic regex → VALIDATION within 2s", async () => {
    const start = Date.now();
    const result = await searchTool.execute({ query: "(a+)+b" }, {
      ...ctx,
      cloneDir: makeBacktrackDir(),
    });
    expect(result.content).toContain('"code": "VALIDATION"');
    expect(Date.now() - start).toBeLessThan(4000);
  });

  it("query over 500 chars → VALIDATION", async () => {
    const result = await searchTool.execute({ query: "a".repeat(501) }, ctx);
    expect(result.content).toContain('"code": "VALIDATION"');
  });

  it("pathGlob narrows the search", async () => {
    const result = await searchTool.execute({ query: "login", pathGlob: "src/other.ts" }, ctx);
    expect(result.content).toContain("src/other.ts");
    expect(result.content).not.toContain("src/auth.ts");
  });
});

function makeBacktrackDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitten-backtrack-"));
  fs.writeFileSync(path.join(dir, "evil.txt"), `${"a".repeat(60)}\n`.repeat(50));
  return dir;
}
