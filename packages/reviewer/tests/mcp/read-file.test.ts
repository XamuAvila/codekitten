import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readFileTool } from "../../src/mcp/read-file.js";
import { createRegistry } from "../../src/mcp/registry.js";
import type { McpContext } from "../../src/mcp/registry.js";
import { DEFAULT_MCP_CONFIG } from "@kitten/shared";

let cloneDir: string;
let ctx: McpContext;

beforeAll(() => {
  cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "kitten-readfile-"));
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
  fs.writeFileSync(path.join(cloneDir, "big.txt"), lines);
  fs.writeFileSync(path.join(cloneDir, "small.txt"), "alpha\nbeta\ngamma\n");
  ctx = { cloneDir, skipPatterns: [], caps: DEFAULT_MCP_CONFIG };
});

afterAll(() => {
  fs.rmSync(cloneDir, { recursive: true, force: true });
});

describe("readFileTool", () => {
  it("returns numbered lines", async () => {
    const result = await readFileTool.execute({ path: "small.txt" }, ctx);
    expect(result.content).toContain("1\talpha");
    expect(result.content).toContain("3\tgamma");
    expect(result.truncated).toBe(false);
  });

  it("honors startLine/endLine", async () => {
    const result = await readFileTool.execute({ path: "small.txt", startLine: 2, endLine: 2 }, ctx);
    expect(result.content).toContain("2\tbeta");
    expect(result.content).not.toContain("alpha");
    expect(result.content).not.toContain("gamma");
  });

  it("caps at read.maxLines with truncated flag", async () => {
    const result = await readFileTool.execute({ path: "big.txt" }, ctx);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain("line 200");
    expect(result.content).not.toContain("line 201");
  });

  it("returns NOT_FOUND for a missing file", async () => {
    const result = await readFileTool.execute({ path: "nope.txt" }, ctx);
    expect(result.content).toContain('"code": "NOT_FOUND"');
  });

  it("returns VALIDATION for an escaping path", async () => {
    const result = await readFileTool.execute({ path: "../../etc/passwd" }, ctx);
    expect(result.content).toContain('"code": "VALIDATION"');
  });

  it("returns VALIDATION for invalid input shape", async () => {
    const result = await readFileTool.execute({ nope: true }, ctx);
    expect(result.content).toContain('"code": "VALIDATION"');
  });
});

describe("createRegistry", () => {
  it("registers readFileTool", () => {
    const registry = createRegistry(cloneDir, [], DEFAULT_MCP_CONFIG);
    expect(registry.get("read_file")?.name).toBe("read_file");
    expect(registry.get("unknown" as never)).toBeUndefined();
  });
});
