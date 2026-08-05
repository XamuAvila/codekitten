import { z } from "zod";

import { toolError } from "./registry.js";
import type { McpContext, McpTool, McpToolResult } from "./registry.js";

const InputSchema = z.strictObject({
  query: z.string().min(1).max(500),
});

// Response shape of the semble sidecar HTTP shim (docker/semble-sidecar/server.py).
const SidecarResponseSchema = z.object({
  results: z.array(
    z.object({
      path: z.string(),
      score: z.number(),
      snippet: z.string(),
    }),
  ),
});

const SIDECAR_TIMEOUT_MS = 10_000;

/**
 * semantic_search — semantic code search via the Semble sidecar container
 * (KIT-036). The sidecar shares the clone volume and owns the index; this
 * tool only talks HTTP to it (the reviewer never touches the index — card
 * decision 3). Sidecar absent/unhealthy → SERVICE_UNAVAILABLE with a lexical
 * fallback hint; the loop continues on search/find_related (epic error table).
 */
export const semanticSearchTool: McpTool = {
  name: "semantic_search",
  description:
    "Semantic code search over the repository — finds code by meaning, not " +
    "text matching. Use for 'code that does X' when identifiers are unknown. " +
    "Falls back: if unavailable, use search/find_related instead.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language or code query", maxLength: 500 },
    },
    required: ["query"],
  },
  async execute(input: unknown, ctx: McpContext): Promise<McpToolResult> {
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      return toolError("VALIDATION", `Invalid semantic_search input: ${parsed.error.issues[0]?.message ?? "bad shape"}`);
    }

    if (ctx.sembleUrl === undefined) {
      return unavailable("Semble sidecar not configured");
    }

    const { maxResults } = ctx.caps.semanticSearch;
    let payload: unknown;
    try {
      const response = await fetch(`${ctx.sembleUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: parsed.data.query, top_k: maxResults + 1 }),
        signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS),
      });
      if (!response.ok) {
        return unavailable(`Semble sidecar returned HTTP ${response.status}`);
      }
      payload = await response.json();
    } catch (error) {
      return unavailable(`Semble sidecar unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }

    const body = SidecarResponseSchema.safeParse(payload);
    if (!body.success) {
      return unavailable("Semble sidecar returned an unexpected response shape");
    }

    const { results } = body.data;
    if (results.length === 0) {
      return { content: "No results", truncated: false };
    }
    const truncated = results.length > maxResults;
    const content = results
      .slice(0, maxResults)
      .map((r) => `${r.path} (score ${r.score.toFixed(3)})\n${r.snippet}`)
      .join("\n---\n");
    return { content, truncated };
  },
};

function unavailable(message: string): McpToolResult {
  return {
    content: JSON.stringify(
      { code: "SERVICE_UNAVAILABLE", message: `${message} — use search/find_related instead` },
      null,
      1,
    ),
    truncated: false,
  };
}
