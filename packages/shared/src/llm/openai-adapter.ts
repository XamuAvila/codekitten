import OpenAI from "openai";
import type { Finding, ReviewResult } from "../types/index.js";
import { FindingSchema } from "../types/index.js";
import type { LLMAdapter, ReviewContext } from "./adapter.js";

/**
 * OpenAIAdapter — LLM review via the OpenAI SDK using
 * `response_format: json_schema` (strict structured output).
 *
 * The JSON schema mirrors FindingSchema — the provider guarantees the shape,
 * so no fragile JSON-string parsing happens downstream.
 */
export class OpenAIAdapter implements LLMAdapter {
  private readonly client: OpenAI;
  private readonly defaultModel: string;

  constructor(opts: { readonly apiKey: string; readonly baseUrl: string; readonly defaultModel?: string }) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
    this.defaultModel = opts.defaultModel ?? "gpt-4o";
  }

  async review(context: ReviewContext): Promise<ReviewResult> {
    const response = await this.client.chat.completions.create({
      model: context.config.model,
      max_tokens: context.config.maxOutputTokens,
      messages: [
        { role: "system", content: context.prompt?.system ?? FALLBACK_SYSTEM },
        { role: "user", content: context.prompt?.user ?? fallbackUserContent(context) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "findings",
          strict: true,
          schema: FINDINGS_SCHEMA,
        },
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI response had no content");
    }

    return {
      findings: parseFindings(content),
      contextChecked: [],
      conventionsStatus: [],
      metadata: {
        model: context.config.model,
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        durationMs: 0,
      },
    };
  }

  async respond(system: string, user: string, maxOutputTokens: number): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.defaultModel,
      max_tokens: maxOutputTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    return response.choices[0]?.message?.content ?? "";
  }
}

const FALLBACK_SYSTEM = [
  "You are an expert code reviewer.",
  "Report only real bugs, security issues, or maintainability problems.",
  "Every finding must reference the exact file and line.",
  "Respond only with a JSON object matching the findings schema.",
].join("\n");

function fallbackUserContent(context: ReviewContext): string {
  const files = context.files
    .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");
  return `Pull request diff:\n${context.diff ?? ""}\n\nChanged files:\n${files}`;
}

/**
 * Parses and validates the JSON content against FindingSchema.
 * Throws on invalid shape — the pipeline maps this to LLM_OUTPUT_INVALID (KIT-012).
 */
function parseFindings(content: string): readonly Finding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("OpenAI response was not valid JSON");
  }

  const raw = (parsed as { findings?: unknown } | null)?.findings;
  const result = FindingSchema.array().safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid findings from LLM: ${result.error.message}`);
  }
  return result.data;
}

const FINDINGS_SCHEMA = {
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
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;
