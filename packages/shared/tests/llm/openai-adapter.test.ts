import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: mockCreate } };
  },
}));

import { OpenAIAdapter } from "../../src/llm/openai-adapter.js";
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
    prompt: {
      system: "You are an expert code reviewer. You never commit, never push.",
      user: "PR diff and files",
    },
  };
}

function chatResponse(json: unknown) {
  return {
    choices: [{ message: { content: JSON.stringify(json) } }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  };
}

describe("OpenAIAdapter", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("sends model, response_format json_schema with FindingSchema shape and strict true", async () => {
    mockCreate.mockResolvedValue(chatResponse({ findings: [] }));
    const adapter = new OpenAIAdapter({ apiKey: "oa-key", baseUrl: "https://api.openai.com" });

    await adapter.review(makeContext());

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [params] = mockCreate.mock.calls[0];

    expect(params.model).toBe(DEFAULT_CONFIG.model);
    expect(params.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "findings", strict: true },
    });
    expect(params.messages[0].content).toContain("never commit");
  });

  it("parses the JSON content into ReviewResult findings", async () => {
    mockCreate.mockResolvedValue(
      chatResponse({
        findings: [
          {
            severity: "medium",
            file: "src/utils.ts",
            line: 3,
            finding: "Possible null dereference",
            suggestion: "Guard with ?.",
          },
        ],
      }),
    );
    const adapter = new OpenAIAdapter({ apiKey: "oa-key", baseUrl: "https://api.openai.com" });

    const result = await adapter.review(makeContext());

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      severity: "medium",
      file: "src/utils.ts",
      line: 3,
      finding: "Possible null dereference",
    });
    expect(result.metadata).toMatchObject({ model: DEFAULT_CONFIG.model, inputTokens: 100, outputTokens: 50 });
  });

  it("throws when content is not valid findings JSON", async () => {
    mockCreate.mockResolvedValue(chatResponse({ findings: [{ severity: "bad" }] }));

    const adapter = new OpenAIAdapter({ apiKey: "oa-key", baseUrl: "https://api.openai.com" });

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

    it("sends tools with tool_choice auto", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: null, tool_calls: [] } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      });
      const adapter = new OpenAIAdapter({ apiKey: "oa-key", baseUrl: "https://api.openai.com" });

      await adapter.explore(makeTurn());

      const [params] = mockCreate.mock.calls[0];
      expect(params.tools).toHaveLength(2);
      expect(params.tools[0]).toMatchObject({
        type: "function",
        function: { name: "read_file", parameters: { type: "object" } },
      });
      expect(params.tool_choice).toBe("auto");
      expect(params.max_tokens).toBe(8000);
      expect(params.messages[0]).toEqual({ role: "system", content: "explore system" });
    });

    it("forces the named function when forcedToolChoice is set", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: null, tool_calls: [] } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      });
      const adapter = new OpenAIAdapter({ apiKey: "oa-key", baseUrl: "https://api.openai.com" });

      await adapter.explore(makeTurn({ forcedToolChoice: { name: "report_findings" } }));

      const [params] = mockCreate.mock.calls[0];
      expect(params.tool_choice).toEqual({ type: "function", function: { name: "report_findings" } });
    });

    it("parses tool_calls into toolUses and content into text", async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: "Reading files.",
              tool_calls: [
                { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"src/a.ts"}' } },
                { id: "c2", type: "function", function: { name: "search", arguments: '{"query":"foo"}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 40 },
      });
      const adapter = new OpenAIAdapter({ apiKey: "oa-key", baseUrl: "https://api.openai.com" });

      const result = await adapter.explore(makeTurn());

      expect(result.text).toBe("Reading files.");
      expect(result.toolUses).toEqual([
        { name: "read_file", input: { path: "src/a.ts" } },
        { name: "search", input: { query: "foo" } },
      ]);
      expect(result.metadata).toMatchObject({ inputTokens: 100, outputTokens: 40 });
    });

    it("returns empty toolUses for a text-only response", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: "just text" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
      const adapter = new OpenAIAdapter({ apiKey: "oa-key", baseUrl: "https://api.openai.com" });

      const result = await adapter.explore(makeTurn());

      expect(result.toolUses).toEqual([]);
      expect(result.text).toBe("just text");
    });
  });

  it("respond returns the text answer for follow-ups", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "The refactor looks safe." } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const adapter = new OpenAIAdapter({ apiKey: "oa-key", baseUrl: "https://api.openai.com" });

    const answer = await adapter.respond("system", "question", 4000);

    expect(answer).toBe("The refactor looks safe.");
    const [params] = mockCreate.mock.calls[0];
    expect(params.max_tokens).toBe(4000);
    expect(params.response_format).toBeUndefined();
  });
});
