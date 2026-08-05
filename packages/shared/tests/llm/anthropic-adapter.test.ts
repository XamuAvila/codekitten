import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

import { AnthropicAdapter } from "../../src/llm/anthropic-adapter.js";
import type { ReviewContext, ReviewFile } from "../../src/llm/adapter.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";

const FILES: readonly ReviewFile[] = [
  { path: "src/utils.ts", content: "export function add(a: number, b: number) { return a + b; }" },
];

function makeContext(): ReviewContext {
  return {
    job: {
      repo: "org/repo",
      prNumber: 1,
      headRef: "head",
      baseRef: "base",
      sender: "test",
    },
    config: DEFAULT_CONFIG,
    files: FILES,
    diff: "diff --git a/src/utils.ts b/src/utils.ts",
  };
}

function toolUseResponse(input: unknown) {
  return {
    content: [
      { type: "tool_use", id: "tool_1", name: "report_findings", input },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

describe("AnthropicAdapter", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("sends model, max_tokens from config, tool with FindingSchema input_schema and tool_choice", async () => {
    mockCreate.mockResolvedValue(toolUseResponse({ findings: [] }));
    const adapter = new AnthropicAdapter({ apiKey: "test-key", baseUrl: "https://api.anthropic.com" });

    await adapter.review(makeContext());

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [params] = mockCreate.mock.calls[0];

    expect(params.model).toBe(DEFAULT_CONFIG.model);
    expect(params.max_tokens).toBe(DEFAULT_CONFIG.maxOutputTokens);
    expect(params.system).toBeTruthy();

    const tool = params.tools[0];
    expect(tool.name).toBe("report_findings");
    expect(tool.input_schema.properties).toHaveProperty("findings");
    expect(tool.input_schema.properties.findings.items.required).toEqual(
      expect.arrayContaining(["severity", "file", "line", "finding"]),
    );
    expect(tool.input_schema.properties.findings.items.properties.severity.enum).toEqual(
      ["critical", "high", "medium", "low"],
    );
    expect(params.tool_choice).toEqual({ type: "tool", name: "report_findings" });
  });

  it("parses tool_use input into ReviewResult findings", async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({
        findings: [
          {
            severity: "high",
            file: "src/utils.ts",
            line: 1,
            finding: "Unused parameter",
            suggestion: "Remove it",
          },
        ],
      }),
    );
    const adapter = new AnthropicAdapter({ apiKey: "test-key", baseUrl: "https://api.anthropic.com" });

    const result = await adapter.review(makeContext());

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      severity: "high",
      file: "src/utils.ts",
      line: 1,
      finding: "Unused parameter",
      suggestion: "Remove it",
    });
    expect(result.metadata).toMatchObject({ model: DEFAULT_CONFIG.model, inputTokens: 100, outputTokens: 50 });
  });

  it("uses the configured baseUrl", async () => {
    mockCreate.mockResolvedValue(toolUseResponse({ findings: [] }));
    const adapter = new AnthropicAdapter({ apiKey: "dk-key", baseUrl: "https://api.deepseek.com/anthropic" });

    await adapter.review(makeContext());

    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("disables thinking for the DeepSeek Anthropic endpoint (forced tool_choice)", async () => {
    mockCreate.mockResolvedValue(toolUseResponse({ findings: [] }));
    const adapter = new AnthropicAdapter({ apiKey: "dk-key", baseUrl: "https://api.deepseek.com/anthropic" });

    await adapter.review(makeContext());

    const [params] = mockCreate.mock.calls[0];
    expect(params.thinking).toEqual({ type: "disabled" });
  });

  it("does not disable thinking for the real Anthropic endpoint", async () => {
    mockCreate.mockResolvedValue(toolUseResponse({ findings: [] }));
    const adapter = new AnthropicAdapter({ apiKey: "test-key", baseUrl: "https://api.anthropic.com" });

    await adapter.review(makeContext());

    const [params] = mockCreate.mock.calls[0];
    expect(params.thinking).toBeUndefined();
  });

  it("throws when tool_use is missing from the response", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "no tools here" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const adapter = new AnthropicAdapter({ apiKey: "test-key", baseUrl: "https://api.anthropic.com" });

    await expect(adapter.review(makeContext())).rejects.toThrow(/tool/i);
  });

  it("throws when findings fail FindingSchema validation", async () => {
    mockCreate.mockResolvedValue(
      toolUseResponse({ findings: [{ severity: "invalid", file: "", line: -1, finding: "" }] }),
    );
    const adapter = new AnthropicAdapter({ apiKey: "test-key", baseUrl: "https://api.anthropic.com" });

    await expect(adapter.review(makeContext())).rejects.toThrow();
  });

  describe("explore", () => {
    const TOOLS = [
      { name: "read_file", description: "Read a file", inputSchema: { type: "object" } },
      { name: "report_findings", description: "Report findings", inputSchema: { type: "object" } },
    ];

    function makeTurn(overrides?: Partial<{ forcedToolChoice: { name: string } }>) {
      return {
        system: "explore system",
        messages: [{ role: "user" as const, content: "explore the repo" }],
        tools: TOOLS,
        maxOutputTokens: 8000,
        ...overrides,
      };
    }

    it("sends the tools array with tool_choice auto", async () => {
      mockCreate.mockResolvedValue({ content: [], usage: { input_tokens: 5, output_tokens: 2 } });
      const adapter = new AnthropicAdapter({ apiKey: "test-key", baseUrl: "https://api.anthropic.com" });

      await adapter.explore(makeTurn());

      const [params] = mockCreate.mock.calls[0];
      expect(params.tools).toHaveLength(2);
      expect(params.tools[0]).toMatchObject({ name: "read_file", input_schema: { type: "object" } });
      expect(params.tool_choice).toEqual({ type: "auto" });
      expect(params.max_tokens).toBe(8000);
      expect(params.system).toBe("explore system");
      expect(params.thinking).toBeUndefined();
    });

    it("forces the named tool when forcedToolChoice is set", async () => {
      mockCreate.mockResolvedValue({ content: [], usage: { input_tokens: 5, output_tokens: 2 } });
      const adapter = new AnthropicAdapter({ apiKey: "test-key", baseUrl: "https://api.anthropic.com" });

      await adapter.explore(makeTurn({ forcedToolChoice: { name: "report_findings" } }));

      const [params] = mockCreate.mock.calls[0];
      expect(params.tool_choice).toEqual({ type: "tool", name: "report_findings" });
    });

    it("keeps thinking disabled for the DeepSeek endpoint", async () => {
      mockCreate.mockResolvedValue({ content: [], usage: { input_tokens: 5, output_tokens: 2 } });
      const adapter = new AnthropicAdapter({ apiKey: "dk-key", baseUrl: "https://api.deepseek.com/anthropic" });

      await adapter.explore(makeTurn());

      const [params] = mockCreate.mock.calls[0];
      expect(params.thinking).toEqual({ type: "disabled" });
    });

    it("parses tool_use blocks into toolUses and text into text", async () => {
      mockCreate.mockResolvedValue({
        content: [
          { type: "text", text: "Let me read the file." },
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "src/a.ts" } },
          { type: "tool_use", id: "t2", name: "search", input: { query: "foo" } },
        ],
        usage: { input_tokens: 100, output_tokens: 40 },
      });
      const adapter = new AnthropicAdapter({ apiKey: "test-key", baseUrl: "https://api.anthropic.com" });

      const result = await adapter.explore(makeTurn());

      expect(result.text).toBe("Let me read the file.");
      expect(result.toolUses).toEqual([
        { name: "read_file", input: { path: "src/a.ts" } },
        { name: "search", input: { query: "foo" } },
      ]);
      expect(result.metadata).toMatchObject({ inputTokens: 100, outputTokens: 40 });
    });

    it("returns empty toolUses for a text-only response", async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: "text", text: "just text" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      const adapter = new AnthropicAdapter({ apiKey: "test-key", baseUrl: "https://api.anthropic.com" });

      const result = await adapter.explore(makeTurn());

      expect(result.toolUses).toEqual([]);
      expect(result.text).toBe("just text");
    });
  });

  it("respond returns the text answer for follow-up questions", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "The change moves validation to the service layer." }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const adapter = new AnthropicAdapter({ apiKey: "test-key", baseUrl: "https://api.anthropic.com" });

    const answer = await adapter.respond("system", "user question", 4000);

    expect(answer).toBe("The change moves validation to the service layer.");
    const [params] = mockCreate.mock.calls[0];
    expect(params.max_tokens).toBe(4000);
    expect(params.tools).toBeUndefined();
  });
});
