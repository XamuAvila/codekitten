import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findRelatedTool } from "../../src/mcp/find-related.js";
import type { McpContext } from "../../src/mcp/registry.js";
import { DEFAULT_MCP_CONFIG } from "@kitten/shared";

let cloneDir: string;
let ctx: McpContext;

beforeAll(() => {
  cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "kitten-related-"));
  fs.mkdirSync(path.join(cloneDir, "src"));
  fs.writeFileSync(
    path.join(cloneDir, "src", "auth.ts"),
    [
      "export function validateToken(token: string) {", // line 1
      "  return token.length > 0;",
      "}",
      "const version = 20260805;", // line 4
      "const x = 1;", // line 5 — only short tokens/keywords
      "return;", // line 6 — keyword only
      "const uniqueSymbolZZZ = 2;", // line 7 — no other occurrences
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(cloneDir, "src", "caller.ts"),
    "import { validateToken } from './auth';\nvalidateToken('abc');\n",
  );
  ctx = { cloneDir, skipPatterns: [], caps: DEFAULT_MCP_CONFIG };
});

afterAll(() => {
  fs.rmSync(cloneDir, { recursive: true, force: true });
});

describe("findRelatedTool", () => {
  it("extracts the identifier and returns repo-wide occurrences with snippets", async () => {
    const result = await findRelatedTool.execute({ file: "src/auth.ts", line: 1 }, ctx);
    expect(result.content).toContain("validateToken");
    expect(result.content).toContain("src/caller.ts");
    expect(result.truncated).toBe(false);
  });

  it("prefers letter tokens over numeric literals of the same length", async () => {
    const result = await findRelatedTool.execute({ file: "src/auth.ts", line: 4 }, ctx);
    expect(result.content).toContain("version");
    expect(result.content).not.toContain("20260805 occurrences");
  });

  it("keyword-only line → 'no identifier found' message, not an error", async () => {
    const result = await findRelatedTool.execute({ file: "src/auth.ts", line: 6 }, ctx);
    expect(result.content.toLowerCase()).toContain("no identifier found");
  });

  it("line beyond the file → helpful miss, not an error", async () => {
    const result = await findRelatedTool.execute({ file: "src/auth.ts", line: 9999 }, ctx);
    expect(result.content.toLowerCase()).toContain("no identifier found");
  });

  it("identifier with no other occurrences → 'no other occurrences'", async () => {
    const result = await findRelatedTool.execute({ file: "src/auth.ts", line: 7 }, ctx);
    expect(result.content.toLowerCase()).toContain("no other occurrences");
  });

  it("caps at findRelated.maxResults with truncated flag", async () => {
    const capped: McpContext = {
      ...ctx,
      caps: { ...DEFAULT_MCP_CONFIG, findRelated: { maxResults: 1 } },
    };
    const result = await findRelatedTool.execute({ file: "src/auth.ts", line: 1 }, capped);
    expect(result.truncated).toBe(true);
  });

  it("escape path → VALIDATION", async () => {
    const result = await findRelatedTool.execute({ file: "../../etc/passwd", line: 1 }, ctx);
    expect(result.content).toContain('"code": "VALIDATION"');
  });
});
