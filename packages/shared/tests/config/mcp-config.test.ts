import { describe, expect, it } from "vitest";

import { parseMcpConfig, DEFAULT_MCP_CONFIG } from "../../src/config/mcp-config.js";
import { AppError } from "../../src/types/index.js";

describe("parseMcpConfig", () => {
  it("parses valid JSON with all fields", () => {
    const config = parseMcpConfig(
      JSON.stringify({
        enabled: true,
        tools: ["read_file", "search"],
        maxTurns: 8,
        forceMaxTurns: 40,
        read: { maxLines: 100, maxFileBytes: 1024 },
        search: { maxResults: 10, contextLines: 1, caseSensitive: true, skip: ["dist/**"] },
        findRelated: { maxResults: 5 },
        listDirectory: { maxEntries: 50 },
      }),
    );

    expect(config.enabled).toBe(true);
    expect(config.tools).toEqual(["read_file", "search"]);
    expect(config.maxTurns).toBe(8);
    expect(config.forceMaxTurns).toBe(40);
    expect(config.read).toEqual({ maxLines: 100, maxFileBytes: 1024 });
    expect(config.search).toEqual({ maxResults: 10, contextLines: 1, caseSensitive: true, skip: ["dist/**"] });
    expect(config.findRelated).toEqual({ maxResults: 5 });
    expect(config.listDirectory).toEqual({ maxEntries: 50 });
  });

  it("falls back to defaults for missing keys", () => {
    const config = parseMcpConfig(JSON.stringify({ enabled: true }));

    expect(config.enabled).toBe(true);
    expect(config.tools).toEqual(DEFAULT_MCP_CONFIG.tools);
    expect(config.maxTurns).toBe(DEFAULT_MCP_CONFIG.maxTurns);
    expect(config.forceMaxTurns).toBe(DEFAULT_MCP_CONFIG.forceMaxTurns);
    expect(config.read).toEqual(DEFAULT_MCP_CONFIG.read);
    expect(config.search).toEqual(DEFAULT_MCP_CONFIG.search);
  });

  it("defaults enabled to false", () => {
    expect(parseMcpConfig(JSON.stringify({})).enabled).toBe(false);
    expect(DEFAULT_MCP_CONFIG.enabled).toBe(false);
  });

  it("rejects unknown keys with VALIDATION", () => {
    expect(() => parseMcpConfig(JSON.stringify({ enabled: true, bogus: 1 }))).toThrowError(AppError);
    try {
      parseMcpConfig(JSON.stringify({ enabled: true, bogus: 1 }));
    } catch (error) {
      expect((error as AppError).code).toBe("VALIDATION");
    }
  });

  it("rejects wrong field types with VALIDATION", () => {
    try {
      parseMcpConfig(JSON.stringify({ maxTurns: "not-a-number" }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION");
    }
  });

  it("rejects invalid JSON with VALIDATION", () => {
    try {
      parseMcpConfig("{ not json");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION");
    }
  });

  it("returns DEFAULT_MCP_CONFIG for empty content", () => {
    expect(parseMcpConfig("")).toEqual(DEFAULT_MCP_CONFIG);
    expect(parseMcpConfig("   ")).toEqual(DEFAULT_MCP_CONFIG);
  });
});
