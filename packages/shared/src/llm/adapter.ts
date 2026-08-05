import type { ReviewJob, ReviewResult, ReviewerConfig } from "../types/index.js";

/**
 * ReviewFile — a changed file with its full content.
 */
export interface ReviewFile {
  readonly path: string;
  readonly content: string;
}

/**
 * ReviewContext — everything the LLM needs to review a PR:
 * the job, the resolved config, the changed files and (when available) the diff.
 */
export interface ReviewContext {
  readonly job: ReviewJob;
  readonly config: ReviewerConfig;
  readonly files: readonly ReviewFile[];
  readonly diff?: string;
  /** Pre-built guardrailed prompt (reviewer's buildReviewPrompt). When
   * absent, the adapter falls back to a minimal internal prompt. */
  readonly prompt?: { readonly system: string; readonly user: string };
}

/**
 * ChatMessage — one turn of the agentic conversation. `content` is either
 * plain text or provider-shaped blocks (tool_use / tool_result) that the
 * adapter passes through to its SDK.
 */
export interface ChatMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly Record<string, unknown>[];
}

/**
 * AgentTool — a tool definition offered to the model on an explore turn.
 * `inputSchema` is a plain JSON Schema; each adapter maps it to its
 * provider's wire shape (input_schema / function.parameters).
 */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/**
 * AgentTurn — one request of the v4 agentic loop.
 */
export interface AgentTurn {
  readonly system: string;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly AgentTool[];
  readonly maxOutputTokens: number;
  /** Force a specific tool choice on this turn (finalize turn). */
  readonly forcedToolChoice?: { readonly name: string };
}

/**
 * ExploreResult — the model's move: zero or more tool calls plus any text.
 */
export interface ExploreResult {
  readonly text?: string;
  readonly toolUses: readonly { readonly name: string; readonly input: Record<string, unknown> }[];
  readonly metadata: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly durationMs: number;
  };
}

/**
 * LLMAdapter — vendor-agnostic interface for review models.
 * Implementations (Anthropic, OpenAI) land in v3 (KIT-011/012).
 */
export interface LLMAdapter {
  /**
   * Run a full structured review. Returns Finding[] via the provider's
   * native structured-output mechanism (tool use / json_schema).
   */
  review(context: ReviewContext): Promise<ReviewResult>;

  /**
   * Free-text answer for follow-up questions (KIT-017). The review()
   * method returns Finding[] only, so follow-ups need a separate path.
   */
  respond(system: string, user: string, maxOutputTokens: number): Promise<string>;

  /**
   * One turn of the v4 agentic loop: send messages + tool definitions,
   * return the model's tool calls. Multi-turn state lives in the caller
   * (runAgenticLoop) — the adapter is stateless.
   */
  explore(turn: AgentTurn): Promise<ExploreResult>;
}
