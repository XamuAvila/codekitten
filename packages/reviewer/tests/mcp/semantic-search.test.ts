import { describe, expect, it, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { semanticSearchTool } from "../../src/mcp/semantic-search.js";
import { createRegistry } from "../../src/mcp/registry.js";
import type { McpContext } from "../../src/mcp/registry.js";
import { DEFAULT_MCP_CONFIG } from "@kitten/shared";

const SIDECAR_URL = "http://127.0.0.1:8765";

function makeCtx(sembleUrl?: string): McpContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitten-semsearch-"));
  return {
    cloneDir: dir,
    skipPatterns: [],
    caps: DEFAULT_MCP_CONFIG,
    ...(sembleUrl !== undefined ? { sembleUrl } : {}),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("semanticSearchTool", () => {
  it("returns ranked snippets from a healthy sidecar, capped at maxResults", async () => {
    const results = Array.from({ length: 15 }, (_, i) => ({
      path: `src/file${i}.ts`,
      score: 1 - i * 0.05,
      snippet: `snippet ${i}`,
    }));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await semanticSearchTool.execute({ query: "auth token handling" }, makeCtx(SIDECAR_URL));

    expect(result.content).toContain("src/file0.ts");
    expect(result.content).toContain("snippet 0");
    // maxResults default 10 → entries beyond the cap dropped, truncated flagged
    expect(result.content).not.toContain("src/file14.ts");
    expect(result.truncated).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${SIDECAR_URL}/search`);
    expect(JSON.parse(init.body).query).toBe("auth token handling");
  });

  it("sidecar down → SERVICE_UNAVAILABLE with lexical fallback hint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await semanticSearchTool.execute({ query: "anything" }, makeCtx(SIDECAR_URL));

    expect(result.content).toContain('"code": "SERVICE_UNAVAILABLE"');
    expect(result.content).toContain("search/find_related");
  });

  it("sidecar non-200 → SERVICE_UNAVAILABLE", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const result = await semanticSearchTool.execute({ query: "anything" }, makeCtx(SIDECAR_URL));

    expect(result.content).toContain('"code": "SERVICE_UNAVAILABLE"');
  });

  it("no sidecar configured → SERVICE_UNAVAILABLE", async () => {
    const result = await semanticSearchTool.execute({ query: "anything" }, makeCtx());
    expect(result.content).toContain('"code": "SERVICE_UNAVAILABLE"');
  });

  it("empty query → VALIDATION", async () => {
    const result = await semanticSearchTool.execute({ query: "" }, makeCtx(SIDECAR_URL));
    expect(result.content).toContain('"code": "VALIDATION"');
  });

  it("query over 500 chars → VALIDATION", async () => {
    const result = await semanticSearchTool.execute({ query: "a".repeat(501) }, makeCtx(SIDECAR_URL));
    expect(result.content).toContain('"code": "VALIDATION"');
  });
});

describe("registry gating", () => {
  it("registers semantic_search only when sembleUrl is provided", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitten-reg-"));
    const withSidecar = createRegistry(dir, [], DEFAULT_MCP_CONFIG, { sembleUrl: SIDECAR_URL });
    const withoutSidecar = createRegistry(dir, [], DEFAULT_MCP_CONFIG);

    expect(withSidecar.get("semantic_search")).toBeDefined();
    expect(withSidecar.ctx.sembleUrl).toBe(SIDECAR_URL);
    expect(withoutSidecar.get("semantic_search")).toBeUndefined();
  });
});
