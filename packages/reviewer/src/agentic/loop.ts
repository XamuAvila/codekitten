import { AppError, FindingSchema } from "@kitten/shared";
import type { AgentTool, ChatMessage, Finding, LLMAdapter, MCPConfig } from "@kitten/shared";

import type { BuiltPrompt } from "../prompt/build-prompt.js";
import { callWithRetry, isAuthError } from "../pipeline/retry.js";
import { toolError } from "../mcp/registry.js";
import type { McpRegistry } from "../mcp/registry.js";

const REPORT_TOOL = "report_findings";

export interface AgenticLoopOptions {
  readonly registry: McpRegistry;
  readonly maxOutputTokens: number;
  /** Overrides mcpConfig.maxTurns (force mode uses forceMaxTurns). */
  readonly maxTurns?: number;
  readonly signal?: AbortSignal;
}

export interface AgenticLoopResult {
  readonly findings: readonly Finding[];
  readonly toolCalls: number;
  readonly hitBudget: boolean;
  /** True when the stop signal aborted the loop (status cancelled). */
  readonly aborted: boolean;
}

/**
 * The v4 agentic loop: the model explores the clone through the registry's
 * read-only tools and finishes by calling report_findings. Bounded by
 * maxTurns; budget exhaustion (or two consecutive text-only turns) forces a
 * finalize turn with tool_choice pinned to report_findings.
 *
 * Message blocks are Anthropic-shaped (tool_use / tool_result) — the
 * adapters pass them through. Synthetic tool_use ids are generated here;
 * the API only requires id consistency within the message list.
 */
export async function runAgenticLoop(
  adapter: LLMAdapter,
  prompt: BuiltPrompt,
  mcpConfig: MCPConfig,
  opts: AgenticLoopOptions,
): Promise<AgenticLoopResult> {
  const maxTurns = opts.maxTurns ?? mcpConfig.maxTurns;
  const tools = buildToolDefinitions(opts.registry);

  let messages: readonly ChatMessage[] = [{ role: "user", content: prompt.user }];
  let toolCalls = 0;
  let textOnlyStreak = 0;
  let callId = 0;

  for (let turn = 0; turn <= maxTurns; turn += 1) {
    if (opts.signal?.aborted) {
      console.log("[reviewer] Agentic loop aborted by stop command");
      return { findings: [], toolCalls, hitBudget: false, aborted: true };
    }

    const isFinalize = turn === maxTurns || textOnlyStreak >= 2;
    // Transient failures (timeout, 5xx, 429) retry with the v3 backoff;
    // auth failures never do (US-027 AC-2).
    const result = await callWithRetry(
      () =>
        adapter.explore({
          system: prompt.system,
          messages,
          tools,
          maxOutputTokens: opts.maxOutputTokens,
          ...(isFinalize ? { forcedToolChoice: { name: REPORT_TOOL } } : {}),
        }),
      { isRetryable: (error) => !isAuthError(error) },
    );

    const report = result.toolUses.find((use) => use.name === REPORT_TOOL);
    if (report) {
      // Sibling tool_uses in the same turn are ignored — the report is
      // authoritative (KIT-023 decision 3).
      const parsed = FindingSchema.array().safeParse(
        (report.input as { findings?: unknown }).findings,
      );
      if (parsed.success) {
        if (toolCalls === 0) {
          console.warn(
            "[reviewer] Agentic review reported without exploring — findings may be weaker than v3 monolithic",
          );
        }
        return { findings: parsed.data, toolCalls, hitBudget: turn >= maxTurns, aborted: false };
      }
      if (isFinalize) {
        throw new AppError("LLM_OUTPUT_INVALID", "Agentic finalize turn produced invalid findings", [
          { error: parsed.error.message },
        ]);
      }
      // Non-final turn: return the parse error as tool output so the model
      // can retry in its next turn (no retry within the same turn).
      const id = `call_${callId++}`;
      messages = [
        ...messages,
        assistantToolUses([{ id, name: REPORT_TOOL, input: report.input }], result.text),
        userToolResults([
          { id, content: toolError("VALIDATION", `Invalid findings: ${parsed.error.message}`).content },
        ]),
      ];
      textOnlyStreak = 0;
      continue;
    }

    if (result.toolUses.length === 0) {
      // Text-only turn: nudge once; a second consecutive one forces finalize.
      textOnlyStreak += 1;
      messages = [
        ...messages,
        { role: "assistant", content: result.text ?? "(no output)" },
        { role: "user", content: "Continue exploring or report findings." },
      ];
      continue;
    }

    textOnlyStreak = 0;
    const uses = result.toolUses.map((use) => ({ ...use, id: `call_${callId++}` }));
    const results: { id: string; content: string }[] = [];
    for (const use of uses) {
      const tool = opts.registry.get(use.name as Parameters<McpRegistry["get"]>[0]);
      if (!tool) {
        const available = opts.registry.list().map((t) => t.name).join(", ");
        results.push({
          id: use.id,
          content: toolError(
            "UNKNOWN_TOOL",
            `Tool '${use.name}' is not available. Available tools: ${available}, ${REPORT_TOOL}.`,
          ).content,
        });
        continue;
      }
      const executed = await tool.execute(use.input, opts.registry.ctx);
      toolCalls += 1;
      results.push({
        id: use.id,
        content: executed.truncated ? `${executed.content}\n[truncated]` : executed.content,
      });
    }

    messages = [...messages, assistantToolUses(uses, result.text), userToolResults(results)];
  }

  // Unreachable: the turn === maxTurns iteration forces report_findings and
  // either returns or throws. Guard kept for safety.
  throw new AppError("LLM_OUTPUT_INVALID", "Agentic loop ended without report_findings");
}

function buildToolDefinitions(registry: McpRegistry): readonly AgentTool[] {
  return [
    ...registry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    {
      name: REPORT_TOOL,
      description: "Report the review findings for this pull request. Call this exactly once to finish.",
      inputSchema: {
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
      },
    },
  ];
}

function assistantToolUses(
  uses: readonly { id: string; name: string; input: Record<string, unknown> }[],
  text: string | undefined,
): ChatMessage {
  return {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...uses.map((use) => ({ type: "tool_use", id: use.id, name: use.name, input: use.input })),
    ],
  };
}

function userToolResults(results: readonly { id: string; content: string }[]): ChatMessage {
  return {
    role: "user",
    content: results.map((result) => ({
      type: "tool_result",
      tool_use_id: result.id,
      content: result.content,
    })),
  };
}
