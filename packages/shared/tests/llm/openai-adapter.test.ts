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
