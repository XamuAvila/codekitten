import Anthropic from "@anthropic-ai/sdk";
import type { Finding, ReviewResult } from "../types/index.js";
import { FindingSchema } from "../types/index.js";
import type { LLMAdapter, ReviewContext, ReviewFile } from "./adapter.js";

/**
 * The tool the model must call with its findings. The input_schema mirrors
 * FindingSchema — the provider guarantees the call shape, so no fragile
 * JSON-string parsing happens downstream.
 *
 * Classic tool use (not output_config) is deliberate: DeepSeek's
 * Anthropic-compatible endpoint supports tools/tool_choice fully but ignores
 * output_config beyond "effort" (api-docs.deepseek.com/guides/anthropic_api).
 */
const FINDINGS_TOOL_NAME = "report_findings";

/**
 * AnthropicAdapter — LLM review via the Anthropic SDK.
 *
 * Covers Anthropic (baseUrl https://api.anthropic.com) AND DeepSeek
 * (baseUrl https://api.deepseek.com/anthropic) — the key is resolved by the
 * caller (KIT-012 factory), never hardcoded here. The key itself is never
 * logged.
 */
export class AnthropicAdapter implements LLMAdapter {
  private readonly client: Anthropic;
  private readonly defaultModel: string;

  constructor(opts: { readonly apiKey: string; readonly baseUrl: string; readonly defaultModel?: string }) {
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
    this.defaultModel = opts.defaultModel ?? "deepseek-v4-flash";
  }

  async review(context: ReviewContext): Promise<ReviewResult> {
    const system = context.prompt?.system ?? FALLBACK_SYSTEM;
    const user = context.prompt?.user ?? fallbackUserContent(context);

    const response = await this.client.messages.create({
      model: context.config.model,
      max_tokens: context.config.maxOutputTokens,
      system,
      messages: [{ role: "user", content: [{ type: "text", text: user }] }],
      tools: [
        {
          name: FINDINGS_TOOL_NAME,
          description: "Report the review findings for this pull request.",
          input_schema: FINDINGS_INPUT_SCHEMA,
        },
      ],
      tool_choice: { type: "tool", name: FINDINGS_TOOL_NAME },
    });

    const toolUse = response.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("LLM response did not contain a tool_use block");
    }

    return {
      findings: parseFindings(toolUse.input),
      contextChecked: [],
      conventionsStatus: [],
      metadata: {
        model: context.config.model,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        durationMs: 0,
      },
    };
  }

  async respond(system: string, user: string, maxOutputTokens: number): Promise<string> {
    const response = await this.client.messages.create({
      model: this.defaultModel,
      max_tokens: maxOutputTokens,
      system,
      messages: [{ role: "user", content: user }],
    });

    const text = response.content.find((block) => block.type === "text");
    return text?.type === "text" ? text.text : "";
  }
}

/** Minimal fallback when the pipeline did not attach a built prompt. */
const FALLBACK_SYSTEM = [
  "You are an expert code reviewer.",
  "Report only real bugs, security issues, or maintainability problems.",
  "Every finding must reference the exact file and line.",
  "Respond ONLY with the report_findings tool call.",
].join("\n");

function fallbackUserContent(context: ReviewContext): string {
  const files = context.files
    .map((f: ReviewFile) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");
  return `Pull request diff:\n${context.diff ?? ""}\n\nChanged files:\n${files}`;
}

/**
 * Validates the tool_use input against FindingSchema. Throws on invalid
 * shape — the pipeline maps this to LLM_OUTPUT_INVALID (KIT-012).
 */
function parseFindings(input: unknown): readonly Finding[] {
  const raw = (input as { findings?: unknown } | null)?.findings;
  const result = FindingSchema.array().safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid findings from LLM: ${result.error.message}`);
  }
  return result.data;
}

const FINDINGS_INPUT_SCHEMA: {
  readonly type: "object";
  readonly properties: {
    readonly findings: {
      readonly type: "array";
      readonly items: {
        readonly type: "object";
        readonly properties: Record<string, unknown>;
        readonly required: string[];
      };
    };
  };
  readonly required: string[];
} = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          file: { type: "string" },
          line: { type: "integer" },
          finding: { type: "string" },
          suggestion: { type: "string" },
          ruleId: { type: "string" },
        },
        required: ["severity", "file", "line", "finding"],
      },
    },
  },
  required: ["findings"],
};
