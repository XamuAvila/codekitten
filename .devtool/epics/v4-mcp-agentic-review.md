---
id: v4-mcp-agentic-review
title: "v4: MCP Agentic Review"
status: active
created: "2026-08-05"
---

# v4: MCP Agentic Review

> The reviewer Pod gains **agentic review**: an opt-in, multi-turn loop in which
> the LLM explores the cloned repo through read-only tools (`read_file`, `search`,
> `find_related`, `list_directory`) instead of receiving a fixed pre-computed
> context. Per-repo opt-in via `.reviewer-mcp.json`. Findings flow through the
> v3 contract unchanged. Value: call-site analysis, pattern-consistency checks,
> deep context without pre-computing everything.

## Problem

v3 gives the LLM a fixed pre-computed context: the diff plus the full contents
of every changed file (`packages/reviewer/src/prompt/build-prompt.ts`,
`packages/reviewer/src/pipeline.ts:71-77`). The model cannot look beyond the
changed files. Three review classes are out of reach:

1. **Call-site analysis** — a PR changes a function signature; checking every
   caller requires reading files the diff does not touch.
2. **Pattern-consistency checks** — "the new code follows a pattern that the
   rest of the repo does not" requires searching the repo, not just the diff.
3. **Deep context on demand** — pre-computing everything is either impossible
   (whole repo) or wasteful (bloating every prompt with files the model never
   needs).

v1 predicted this as the "MCP Agentic Review" phase and flagged Semble
standalone viability in Docker as a blocker (v1 epic, "Future phases" table).

## Solution (v4 scope)

An **opt-in agentic review mode**:

1. **Per-repo opt-in** — a repo enables it with `.reviewer-mcp.json`
   (`enabled: true`). Absent, disabled, or invalid config → the v3 monolithic
   path runs unchanged. Zero regression risk for existing repos.
2. **Read-only repository tools** — four in-process TypeScript tools exposed to
   the LLM via the existing Anthropic/OpenAI native tool-use mechanism:
   `read_file`, `search`, `find_related`, `list_directory`. Read-only **by
   construction**: no write tools exist, and every executor is root-confined to
   the clone dir (invariant 1 enforced at the executor boundary, not just by a
   prompt guardrail).
3. **Agentic loop** — the pipeline sends a compact prompt (diff + changed-file
   index, NOT full contents) with the tools registered; the model explores by
   calling tools, and the loop feeds each `tool_result` back until the model
   calls `report_findings` **and its output passes `FindingSchema` validation**
   or the turn budget runs out (finalize turn forces reporting). A
   `report_findings` call whose findings fail validation is treated as a
   tool-use error — the model gets the error back and can retry in the next
   turn (no retry on the same turn). If the finalize turn also fails
   validation, the review fails with `LLM_OUTPUT_INVALID`.
4. **Bounded budget** — `maxTurns` (default 12) + per-result caps on every
   tool. Agentic mode replaces the v3 file-content chunking path; `force` and
   `stop` map onto the existing command plumbing.
5. **Unchanged findings contract** — the loop ends with the same
   `report_findings` tool; `Finding[]` flows through `consolidateFindings` →
   `postPrReview` (inline/table hybrid, blocking, language, rules) exactly as
   in v3.

## Implementation Cards

Execution order (sequential — each depends on the previous):

| Card | Story | Scope |
|---|---|---|
| [KIT-023](../features/KIT-023-agentic-review-opt-in.md) | [US-023](../../docs/stories/US-023-agentic-review-opt-in.md) | `MCPConfig` schema/parse, `explore()` on `LLMAdapter`, `read_file` tool + confinement, agentic loop (maxTurns, finalize, stop), pipeline branch, findings via v3 contract |
| [KIT-024](../features/KIT-024-repo-search-tool.md) | [US-024](../../docs/stories/US-024-repo-search-tool.md) | `search` tool in the loop (regex, skip patterns, caps, truncation) |
| [KIT-025](../features/KIT-025-related-code-tools.md) | [US-025](../../docs/stories/US-025-related-code-tools.md) | `find_related` (identifier extraction → repo-wide occurrences) + `list_directory` |
| [KIT-026](../features/KIT-026-agentic-cost-control.md) | [US-026](../../docs/stories/US-026-agentic-cost-control.md) | per-tool caps + `tools` whitelist enforcement, `force` escalation, budget-exceeded UX, tool-call metadata |
| [KIT-027](../features/KIT-027-agentic-context-guard.md) | [US-027](../../docs/stories/US-027-agentic-review-hardening.md) | `maxContextTokens` guard on the agentic prompt (diff truncation + force invitation) |
| [KIT-028](../features/KIT-028-agentic-turn-retry.md) | [US-027](../../docs/stories/US-027-agentic-review-hardening.md) | `callWithRetry` around explore turns (transient errors retried, 401 never) |
| [KIT-029](../features/KIT-029-agentic-stop-semantics.md) | [US-027](../../docs/stories/US-027-agentic-review-hardening.md) | aborted loop → pipeline posts nothing (cancelled UX stays in stop plumbing) |
| [KIT-030](../features/KIT-030-agentic-cost-transparency.md) | [US-027](../../docs/stories/US-027-agentic-review-hardening.md) | real token accounting + per-turn tool logging |

Step-by-step TDD implementation plans live in each card's
`## Implementation Plan` section.

## Architecture

```
Pipeline (v4)
 1-2. Clone → diff → PR files → .reviewer.yml      (unchanged)
 3.   Read .reviewer-mcp.json → MCPConfig
        ├─ absent / disabled / invalid  → v3 monolithic path, unchanged
        └─ enabled                      → agentic path:
 4.   a. Agentic prompt:
          system = v3 guardrails + agentic block (explore first, budget,
                   tools are read-only, end with report_findings)
          user   = conventions + rules + diff + changed-file INDEX
                   (path, status, patch size) — NOT full contents
      b. Agentic loop (≤ maxTurns):
          adapter.explore() — tools = [read_file, search, find_related,
                            list_directory, report_findings], tool_choice:
                            auto, thinking disabled (DeepSeek)
          → execute tool_uses via the tool registry (root-confined, capped)
          → feed back tool_result; end on report_findings
          → budget exhausted → finalize turn (tool_choice forced to
            report_findings)
          → AbortSignal checked between turns (stop)
      c. findings → consolidateFindings → postPrReview        (unchanged)
```

### LLM adapter: new `explore()` method

The agentic loop needs a method that sends arbitrary messages with tool
definitions and returns tool-use blocks — v3's `review()` forces a single
`report_findings` call and cannot express a multi-turn exploration.

```typescript
// packages/shared/src/llm/adapter.ts — added to LLMAdapter
interface AgentTurn {
  readonly system: string;
  readonly messages: readonly ChatMessage[]; // { role, content } incl. tool_result blocks
  readonly tools: readonly AgentTool[];
  readonly maxOutputTokens: number;
  /** Force a specific tool choice on this turn (finalize turn). */
  readonly forcedToolChoice?: { readonly name: string };
}

interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

interface ExploreResult {
  readonly text?: string;
  readonly toolUses: readonly { readonly name: string; readonly input: Record<string, unknown> }[];
  readonly metadata: { readonly inputTokens: number; readonly outputTokens: number; readonly durationMs: number };
}

// LLMAdapter gains:
explore(turn: AgentTurn): Promise<ExploreResult>;
```

Both `AnthropicAdapter` (tools + `tool_choice: "auto"`; DeepSeek keeps
`thinking: disabled`) and `OpenAIAdapter` (Chat Completions `tools` +
`tool_choice`) implement it — the loop must stay vendor-agnostic (v3
KIT-012 invariant). `report_findings` is always in the tools array so the
model can finish the review mid-loop.

### Tool registry

```typescript
// packages/reviewer/src/mcp/registry.ts
interface McpTool {
  readonly name: "read_file" | "search" | "find_related" | "list_directory";
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  execute(input: unknown, ctx: McpContext): Promise<McpToolResult>;
}

interface McpContext {
  readonly cloneDir: string;
  readonly skipPatterns: readonly string[]; // from ReviewerConfig.skip
  readonly caps: MCPConfig;                 // per-tool caps
}

interface McpToolResult {
  readonly content: string;  // text fed back as tool_result
  readonly truncated: boolean;
}
```

The registry is the swap point for a real MCP server (e.g. Semble) in a later
phase: a future `SembleTool` would implement the same `McpTool` interface and
the loop would not change.

## Stack

| Component | Technology |
|---|---|
| Language | TypeScript (Node.js), same as v3 |
| Tool mechanism | Anthropic/OpenAI native tool use (already used by v3 for `report_findings`) |
| Search engine | ripgrep-style regex over the clone via `child_process`/fs walk (no new native deps; picomatch already present for skip patterns) |
| Read-only enforcement | root confinement + no write tools + per-call caps |
| Config parsing | zod strict schema (same pattern as `.reviewer.yml`) |
| Testing | vitest, mocked SDK + real DeepSeek integration (v3 pattern) |

## Types (shared package)

```typescript
// MCPConfig — parsed from .reviewer-mcp.json (shared, new module
// packages/shared/src/config/mcp-config.ts)
interface MCPConfig {
  readonly enabled: boolean;                          // default false
  readonly tools: readonly McpToolName[];             // default all four
  readonly maxTurns: number;                          // default 12
  readonly forceMaxTurns: number;                     // default 60
  readonly read: { readonly maxLines: number; readonly maxFileBytes: number };
  readonly search: {
    readonly maxResults: number;
    readonly contextLines: number;
    readonly caseSensitive: boolean;
    readonly skip: readonly string[];                 // additive to ReviewerConfig.skip
  };
  readonly findRelated: { readonly maxResults: number };
  readonly listDirectory: { readonly maxEntries: number };
}

type McpToolName = "read_file" | "search" | "find_related" | "list_directory";
```

`Finding`, `ReviewResult`, `ReviewerConfig`, `ReviewStatus`: **unchanged** (Q6 —
findings contract reused verbatim).

## Config (.reviewer-mcp.json)

Read from the repo root next to `.reviewer.yml`. Missing → disabled
(fail-safe to v3). Invalid JSON or schema violation → logged warning, treated
as disabled (mirrors `.reviewer.yml`'s parse fallback — a bad file must not
fail a review). Strict zod schema: unknown keys → `VALIDATION`.

```json
{
  "enabled": true,
  "tools": ["read_file", "search", "find_related", "list_directory"],
  "maxTurns": 12,
  "read": { "maxLines": 200, "maxFileBytes": 262144 },
  "search": { "maxResults": 30, "contextLines": 2, "caseSensitive": false, "skip": [] },
  "findRelated": { "maxResults": 20 },
  "listDirectory": { "maxEntries": 100 }
}
```

Additive only: `.reviewer-mcp.json` never overrides provider/model/blocking/
language — those stay in `.reviewer.yml`. A repo-supplied config can only widen
or narrow tool behavior, never grant write access (there are no write tools to
grant).

## Agentic prompt

System prompt = the v3 guardrails **plus** an agentic block:

1. **Explore before reporting** — use the tools to inspect the repo beyond the
   diff: read changed files in full, search for usages and patterns, find
   related code. Do not guess what is in the repo — look it up.
2. **Tools are read-only** — you can only read. Never attempt to modify
   anything (there is no tool that writes).
3. **Budget** — you have at most `maxTurns` tool rounds. Spend them on the
   questions that most affect finding quality.
4. **Finish** — end by calling `report_findings` with the v3 Finding schema.
   Precision guardrails (exact `file:line` in the diff, no style/praise,
   max_findings, complexity threshold) are unchanged.

User content:

```
Repository conventions: {conventionsContent}      // if present
Reviewer rules:   {rules}                          // from .reviewer.yml

Pull request diff:
{diff}

Changed files (index — read full contents with read_file):
- src/auth.ts          (+120 -14, 2.1KB)
- src/utils/http.ts    (+8 -2, 480B)
...
```

The diff stays in the prompt so findings can still anchor to exact diff lines.

## Tool surface + read-only enforcement (invariant 1)

| Tool | Semantics | Default caps |
|---|---|---|
| `read_file(path, startLine?, endLine?)` | numbered lines from a clone-dir file | 200 lines / 256 KiB per call |
| `search(query, pathGlob?, caseSensitive?)` | regex over the tree, honoring `ReviewerConfig.skip` + `MCPConfig.search.skip` + `.git` exclusion | 30 results + 2 context lines |
| `find_related(file, line)` | extract identifier at file:line → repo-wide occurrences (call-sites/usages) | 20 results |
| `list_directory(path)` | one-level entries (name + dir flag) | 100 entries |

**Read-only by construction**:
- The registry exposes **no write tools**. Nothing in the tool layer can call
  a mutating fs API.
- **Root confinement** (`confinement.ts`): every path is resolved against the
  clone dir and the resolved path must remain inside it (`path.resolve` +
  prefix check; rejects `..` traversal; resolves symlinked parents via
  `fs.realpath`). Escapes → tool result `{ code: "VALIDATION" }`.
- **Exclusions**: `.git/` and skip patterns are never searched or read.
- **Caps**: per-call size limits with a `truncated: true` flag on results.
- Missing files → tool result `{ code: "NOT_FOUND" }`.

## Budget and its interaction with v3 mechanics

- **`maxTurns`** (default 12) bounds the loop. Exhausted without
  `report_findings` → one **finalize turn** with `forcedToolChoice:
  report_findings`.
- **Per-result caps** bound each tool result; `maxContextTokens` still guards
  the initial user prompt.
- **Chunking**: agentic mode replaces the file-content chunking path
  (`chunker/chunk.ts`) — the context starts small, so per-chunk LLM rounds are
  unnecessary. Monolithic mode keeps v3 chunking untouched.
- **`stop`** (message command): the AbortSignal is checked between turns; the
  loop aborts, status `cancelled`, "Review cancelled" comment, Pod exits
  (v3 KIT-016 plumbing).
- **`force`** (message command): re-runs the loop with `forceMaxTurns` (default
  60). Reuses `PipelineOptions.ignoreBudget` — when set, the agentic loop reads
  `forceMaxTurns` instead of `maxTurns`. A budget-exceeded review posts the v3
  budget-question comment ("Reply `force` …"), reusing
  `budgetQuestionComment` (`pipeline.ts:298`).

## Error handling

| Error | Behavior |
|---|---|
| `.reviewer-mcp.json` invalid/missing | Log warning, treat as disabled → v3 monolithic path |
| Tool path escapes clone root | Tool result `{ code: "VALIDATION" }`, loop continues |
| Tool file/folder not found | Tool result `{ code: "NOT_FOUND" }`, loop continues |
| Model calls unknown tool name | Tool result `{ code: "UNKNOWN_TOOL" }` with available-tool list, loop continues |
| Model never reports after finalize | Review `failed` with `LLM_OUTPUT_INVALID` (new `AppErrorCode`; v3 throws bare `Error` for parse failures — v4 wraps in `AppError` so the pipeline can distinguish invalid output from transient failures) |
| Model reports but findings fail `FindingSchema` parsing (non-final turn) | The parse error is returned as tool output; the model can retry in the next turn (like any tool error). No retry within the same turn. |
| Model reports but findings fail `FindingSchema` parsing (finalize turn) | Review `failed` with `LLM_OUTPUT_INVALID` — the last chance produced invalid output |
| Budget exhausted, findings reported | Findings posted + budget-question comment inviting `force` |
| `stop` mid-loop | Loop aborts, status `cancelled`, comment, Pod exits |
| LLM auth / rate limit / timeout | v3 `callWithRetry` (3 attempts, backoff 1s→2s→4s, no retry on 401) |
| `force`/`stop` to dead Pod | 404/410 `{ code: "NOT_FOUND", ... }` (dispatcher routes, unchanged) |

Structured errors everywhere: `{ code, message, details }`.

## Testing strategy

| Level | What | Notes |
|---|---|---|
| Unit | `MCPConfig` parse (valid/invalid/absent/unknown-key), confinement (escape, `.git`, skip, caps, truncation), each tool executor, loop orchestration (turn accounting, finalize, stop abort, report_findings end) | vitest, mocked SDK |
| Integration | Real DeepSeek agentic loop on a fixture repo — small controlled budget; verify multi-turn tool-result loops work on the DeepSeek Anthropic endpoint (risk gate). **If this fails:** the vendor-agnostic adapter design (v3 KIT-012) allows switching to OpenAI (Chat Completions `tools` + `tool_choice`), which supports multi-turn tool calls natively. This is a **dev-time provider choice**, not runtime failover — v3 explicitly rejected runtime provider fallback (v3 epic out-of-scope). The DeepSeek discount is lost, but the adapter interface does not change. | vitest with real `DEEPSEEK_API_KEY` |
| Component | Pipeline branch (enabled vs disabled), `force`/`stop` on an agentic job | Redis in container |
| E2E | minikube: `.reviewer-mcp.json` enabled → agentic findings posted; disabled → byte-identical to v3 | `scripts/e2e-test.sh` (extended) |

Coverage target: 80%+ on shared + reviewer.

## Recorded decisions (v4 brainstorm — 2026-08-05)

| # | Question | Decision |
|---|---|---|
| D1 | Tool implementation (v1 blocker: Semble viability) | **Hand-rolled in-process TypeScript tools.** Semble is real but Python-only (`uvx --from "semble[mcp]"`), has no `read_file` tool, and its semantic `find_related` is v7 "Deep Context" territory. Hand-rolled gives read-only by construction, vitest-testability, no image/infra change. Semble stays swappable behind the `McpTool` registry in a later phase. |
| D2 | Trigger path | **Opt-in via `.reviewer-mcp.json`** (`enabled: true`). Absent/invalid → v3 monolithic unchanged. No regression risk for existing white-label repos. |
| D3 | Tool surface | **`read_file`, `search`, `find_related`, `list_directory`** — all four. Read-only enforced by construction (no write tools + root confinement + caps), not by prompt alone. |
| D4 | Budget model | **Turn cap + per-result caps.** `maxTurns` (default 12) + per-tool size caps; agentic mode replaces file-content chunking; `force` raises the cap to `forceMaxTurns` (60). |
| D5 | Config shape | **Separate `.reviewer-mcp.json`**, strict zod, additive to `.reviewer.yml`, fail-safe to monolithic when invalid/missing. |
| D6 | Findings contract | **Unchanged.** Loop ends with the same `report_findings` tool; `Finding[]`/consolidation/PR posting reused verbatim. `evidence` traceability deferred to a future phase. |

## What is NOT in v4 (out-of-scope)

- Semble / embedding-based semantic search — v7 "Deep Context"
- `evidence` or any change to the `Finding` contract — future phase
- Agentic follow-ups (tools available inside follow-up answers) — follow-ups
  keep v3's `respond()` path
- GitHub webhook (`POST /webhook/github`) — v5
- GitHub App installation/auth — v6
- OS-level sandboxing (beyond root confinement + read-only registry + no
  secrets) — future hardening
- Caching agentic exploration across jobs — violates job isolation (invariant 5)
- Cost tracking / budget alerts, dashboard / UI — future phases

## Future phases (reference only)

| Phase | Scope |
|---|---|
| v5 — GitHub Webhook | `POST /webhook/github`, signature validation, auto-trigger, "@reviewer" comment → message routing (reuses force/stop/follow-up handlers) |
| v6 — GitHub App | Installation flow, per-installation tokens, multi-tenant |
| v7 — Deep Context | Semble semantic search as an `McpTool` implementation, git log history, pattern comparison, learning from past reviews |
| v8 — Production | Helm chart, monitoring, cost tracking, multi-repo |
