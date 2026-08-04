---
id: v3-llm-integration
title: "v3: LLM Integration"
status: done
created: "2026-08-03"
---

# v3: LLM Integration

> Real LLM code reviews. The dry-run becomes a real review: the reviewer Pod calls an LLM (Anthropic SDK — Anthropic or DeepSeek compatible endpoints, or OpenAI) with a monolithic guardrailed prompt, receives structured `Finding[]` via native tool use, and posts them on the PR — inline when possible, table as fallback. Large PRs are reviewed in chunks with multi-round consolidation, with `force` and `stop` commands via follow-up messages.

## Problem

v2 proved the full pipeline (dispatcher → Pod → clone → diff → comment → follow-up → idle shutdown) with a **dry run** — token estimates and a placeholder comment. The core value is missing: an actual LLM review with real findings. The `LLMAdapter` interface (`packages/shared/src/llm/adapter.ts`) has zero implementations.

Four gaps block real reviews:

1. **No LLM call** — dry-run estimates tokens, never invokes a model.
2. **No findings** — `ReviewResult` with `Finding[]` is never produced.
3. **No real PR feedback** — placeholder comment, not findings with file:line.
4. **No context-aware follow-ups** — follow-ups are echo/ack, not LLM answers referencing the review.

## Solution (v3 scope)

Implement the full LLM review path inside the reviewer Pod:

1. **Monolithic guardrailed prompt** — system prompt with hard guardrails (no commit/push ever, only valuable findings, exact file:line, no style nits, no praise, cyclomatic complexity awareness, max 20 findings) + context (conventions file, config rules) + user content (diff, changed files).
2. **Native structured output** — tool use with `input_schema` (Anthropic — universal, works on Anthropic AND the DeepSeek Anthropic endpoint) / `response_format: json_schema` (OpenAI) returning `Finding[]`. Zero fragile JSON parsing. **Note:** Anthropic's newer `output_config.format.json_schema` is NOT supported by the DeepSeek Anthropic endpoint (compat table: "output_config: Only effort is supported") — classic tool use is the universal path; `output_config` is a future Anthropic-only optimization.
3. **Multi-vendor adapters** — `AnthropicAdapter` (SDK covers Anthropic + DeepSeek via `base_url`) and `OpenAIAdapter`. Key resolved by `base_url` exact match.
4. **Hybrid PR posting** — try GitHub PR Review with inline comments (`line`/`side`/`subject_type: line` — the modern API; legacy `position` avoided); fall back to a Markdown table in the review body.
5. **Chunked multi-round review** — PRs exceeding `max_context_tokens` are split into chunks, each reviewed separately, findings consolidated and deduped. **Two distinct token limits:** `max_context_tokens` (chunking budget, default 1M) vs `max_output_tokens` (per-request LLM output limit — DeepSeek caps at 384K, Anthropic models lower; default ~16K).
6. **`force` / `stop` commands** — via `POST /review/:jobId/message` (same handler reused by the future v5 webhook).
7. **Contextual follow-ups** — `explain`/follow-up questions answered by the LLM with the review context (findings + prompt) available in the Pod.

## Implementation Cards

Execution order (sequential — each depends on the previous):

| Card | Story | Scope |
|---|---|---|
| [KIT-011](../features/KIT-011-llm-review.md) | [US-011](../../docs/stories/US-011-llm-review.md) | AnthropicAdapter, monolithic guardrailed prompt, tool use Finding[], post findings as table comment |
| [KIT-012](../features/KIT-012-multi-vendor.md) | [US-012](../../docs/stories/US-012-multi-vendor.md) | OpenAIAdapter, `provider`/`base_url` config, key resolution by base_url, DeepSeek via Anthropic SDK |
| [KIT-013](../features/KIT-013-inline-comments.md) | [US-013](../../docs/stories/US-013-inline-diff-comments.md) | GitHub PR Review with inline comments (`line`/`side`, not legacy `position`), table fallback |
| [KIT-014](../features/KIT-014-chunked-review.md) | [US-014](../../docs/stories/US-014-chunked-multi-round-review.md) | Token budget check, file chunking, multi-round LLM calls, finding consolidation/dedup |
| [KIT-015](../features/KIT-015-force-command.md) | [US-015](../../docs/stories/US-015-force-full-review.md) | `force` command via message, unlimited review (budget-exceeded comment is posted by KIT-014) |
| [KIT-016](../features/KIT-016-stop-command.md) | [US-016](../../docs/stories/US-016-stop-review.md) | `stop` command, chunk abort, status `cancelled`, cleanup |
| [KIT-017](../features/KIT-017-contextual-followups.md) | [US-017](../../docs/stories/US-017-contextual-followups.md) | LLM-powered follow-ups with review context (findings + prompt) |

Step-by-step TDD implementation plans live in each card's `## Implementation Plan` section.

## Architecture

```
POST /review → Dispatcher → K8s Pod (reviewer)
                                    │
                                    ▼
                        1. Clone repo (auth)
                        2. Diff baseRef...headRef
                        3. Fetch PR files (GitHub API)
                        4. Read .reviewer.yml (provider, base_url, model, max_tokens, ...)
                        5. Build monolithic prompt (guardrails + conventions + diff + files)
                        6. Chunk if over max_tokens  ──► multi-round LLM calls
                        7. Call LLM via adapter (tool use / json_schema)
                        8. Consolidate Finding[] (dedup by file:line)
                        9. Post PR Review (inline diff comments, table fallback)
                       10. Agent mode: follow-ups (LLM answers), force/stop commands
```

### LLM adapter resolution

```
ReviewerConfig.provider
        │
        ├── "anthropic" ──► AnthropicAdapter (Anthropic SDK)
        │                      base_url default: https://api.anthropic.com
        │                      DeepSeek: base_url: https://api.deepseek.com/anthropic
        │
        └── "openai" ────► OpenAIAdapter (OpenAI SDK)
                             base_url default: https://api.openai.com
```

### Key resolution by base_url (exact match)

| base_url | Key env |
|---|---|
| `https://api.anthropic.com` | `ANTHROPIC_API_KEY` |
| `https://api.deepseek.com/anthropic` | `DEEPSEEK_API_KEY` |
| `https://api.openai.com` | `OPENAI_API_KEY` |
| unknown | validation error — `{ code: "VALIDATION" }` |

One K8s Secret (`kitten-llm-keys`) with all three keys; the Pod resolves by URL at runtime. Same pattern as v2's `kitten-github-token`.

### Chunking flow (PR over budget)

```
1. Estimate tokens from diff + files + conventions
2. If total <= max_context_tokens (default 1_000_000): single LLM call
3. Else: split changed files into chunks (largest first, fill to budget)
4. Review each chunk (LLM call per chunk, same guardrailed prompt)
5. Consolidate: dedup by file:line, merge Finding[]
6. Post comment on PR: "PR exceeds token budget. Reply `force` for a full review without limits."
7. Pod stays alive (idle timer reset), waiting for `force` / `stop`
```

### Commands (via POST /review/:jobId/message)

| Message | Effect |
|---|---|
| `force` | Cancels the budget question — re-runs review without `max_context_tokens` limit (full context) |
| `stop` | Aborts remaining chunks, reports status `cancelled`, posts "Review cancelled" comment, Pod exits |
| other | Follow-up question — answered by LLM with review context (findings + original prompt) |

The message handler is the same one v5's webhook will call — the webhook only translates "PR comment" → `POST /review/:jobId/message`.

## Stack

| Component | Technology |
|---|---|
| Language | TypeScript (Node.js) |
| Anthropic SDK | `@anthropic-ai/sdk` (covers DeepSeek via base_url) |
| OpenAI SDK | `openai` |
| Structured output | Tool use with `input_schema` (Anthropic — works on Anthropic + DeepSeek) / `response_format: json_schema` (OpenAI) |
| GitHub API | Existing octokit usage in reviewer (`github/`) |
| Token estimation | Existing dry-run logic, adapted |
| Testing | vitest + real LLM calls (DeepSeek — cheap, configurable base_url) |

## Types (shared package)

```typescript
// ReviewerConfig — extended (v3)
interface ReviewerConfig {
  readonly provider: 'anthropic' | 'openai';   // NEW — default "anthropic"
  readonly baseUrl?: string;                    // NEW — default = provider official URL
  readonly language: string;                    // default "en"
  readonly model: string;                       // default "deepseek-v4-flash"
  readonly maxContextTokens: number;            // NEW (renamed) — chunking budget, default 1_000_000
  readonly maxOutputTokens: number;             // NEW — per-request output limit, default 16_000 (DeepSeek caps 384K)
  readonly maxFindings: number;                 // NEW — default 20
  readonly maxComplexity: number;               // NEW — default 10 (cyclomatic threshold)
  readonly trigger: string;                     // default "@reviewer"
  readonly blocking: 'comment_only' | 'request_changes';
  readonly skip: readonly string[];
  readonly conventionsFile: string;             // default "CLAUDE.md"
  readonly rules: readonly ReviewRule[];
}

// Finding — already exists (shared), consumed by review output
interface Finding {
  readonly severity: 'critical' | 'high' | 'medium' | 'low';
  readonly file: string;
  readonly line: number;
  readonly finding: string;
  readonly suggestion?: string;
  readonly ruleId?: string;
}

// ReviewStatus — extended (v3)
// status: "queued" | "running" | "reviewing" | "completed" | "failed" | "cancelled"  (+cancelled)
```

## Config (.reviewer.yml) — v3 shape

```yaml
reviewer:
  provider: anthropic            # anthropic | openai
  base_url: https://api.deepseek.com/anthropic   # optional; default = provider official URL
  language: en
  model: deepseek-v4-flash
  max_context_tokens: 1000000    # NEW — chunking budget (was max_tokens, default 1M)
  max_output_tokens: 16000       # NEW — per-request output limit (DeepSeek caps at 384K)
  max_findings: 20               # NEW
  max_complexity: 10             # NEW — cyclomatic complexity threshold
  trigger: "@reviewer"
  blocking: comment_only
  skip:
    - "**/Migrations/**"
    - "*.Designer.cs"
    - "**/*.snap"
    - "**/node_modules/**"
  conventions_file: CLAUDE.md
  rules: []
```

DeepSeek needs no special provider value — `provider: anthropic` + `base_url: https://api.deepseek.com/anthropic` (DeepSeek is Anthropic-compatible; verified against `api-docs.deepseek.com`).

**Default shipped vs default resolution:** `DEFAULT_CONFIG` (no `.reviewer.yml`) ships `provider: anthropic`, `base_url: https://api.deepseek.com/anthropic`, `model: deepseek-v4-flash` — the product default is DeepSeek (cheap, user decision). When `base_url` is absent from `.reviewer.yml`, it resolves to the provider's official URL (`api.anthropic.com` / `api.openai.com`).

## Monolithic prompt (guardrails — non-negotiable)

System prompt, in order:

1. **Role**: expert code reviewer following the repo's conventions.
2. **Scope**: review ONLY. Never commit, never push, never modify files. The reviewer has read-only access and no write intent.
3. **Findings quality**: only real bugs, security issues, or maintainability problems that cost the developer time to fix. No style, formatting, or whitespace comments. No praise. When unsure, do not report.
4. **Precision**: every finding MUST reference exact `file:line`.
5. **Complexity**: flag functions whose cyclomatic complexity exceeds `max_complexity` (default 10).
6. **Budget**: report at most `max_findings` (default 20) findings, prioritizing by severity. Valuable over numerous.
7. **Output contract**: respond ONLY with the structured output (tool call / JSON schema). No preamble, no other text.

User content:

```
Conventions file: {conventionsContent}   // CLAUDE.md / AGENTS.md from repo
Reviewer rules:   {rules}                // from .reviewer.yml

PR diff:
{diff}

Changed files (full content):
{files}
```

## Project structure changes

```
packages/shared/
├── src/
│   ├── llm/
│   │   ├── adapter.ts              # LLMAdapter interface (exists)
│   │   ├── anthropic-adapter.ts    # NEW — tool use, base_url support
│   │   ├── openai-adapter.ts       # NEW — response_format json_schema
│   │   ├── factory.ts              # NEW — provider/base_url → adapter + key env
│   │   └── index.ts
│   └── config/
│       ├── defaults.ts             # + provider, baseUrl, maxFindings, maxComplexity, maxTokens 1M
│       └── parse-config.ts         # + new fields (Zod)

packages/reviewer/
├── src/
│   ├── pipeline.ts                 # dry-run → real LLM review
│   ├── prompt/
│   │   ├── build-prompt.ts         # NEW — monolithic guardrailed prompt
│   │   └── index.ts
│   ├── chunker/
│   │   ├── chunk.ts                # NEW — split files into budget-sized chunks
│   │   ├── consolidate.ts          # NEW — dedup findings by file:line
│   │   └── index.ts
│   ├── github/
│   │   ├── comment.ts              # post findings (table fallback)
│   │   ├── review.ts               # NEW — PR Review API, inline comments (line/side, not legacy position)
│   │   └── index.ts
│   ├── agent.ts                    # + force/stop command handling, contextual follow-ups
│   └── redis/status.ts             # + "cancelled" status

k8s/
└── secret.yaml                     # + kitten-llm-keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY)
```

## Error handling

| Error | Behavior |
|---|---|
| Invalid payload | 400 `{ code: "VALIDATION", message, details }` |
| Unknown base_url | Validation error `{ code: "VALIDATION" }` — no key mapping |
| LLM auth failure (401) | Review `failed`, error `AUTH_FAILED` |
| LLM rate limit / timeout | Retry: 3 attempts, backoff 1s → 2s → 4s; all fail → `failed` |
| Invalid structured output | Retry once; still invalid → `failed` with `LLM_OUTPUT_INVALID` (tool use `input_schema` mismatch) |
| Chunk LLM call fails (multi-round) | Failed chunks skipped, successful chunks reported, warning comment |
| `force`/`stop` to dead Pod | 404/410 `{ code: "NOT_FOUND", message: "Job {jobId} not found" }` (dispatcher `routes/message.ts:36`) or `"Job {jobId} is no longer active"` (line 42) |
| `stop` mid-review | Remaining chunks aborted, status `cancelled`, "Review cancelled" comment, Pod exits |

Structured errors everywhere: `{ code, message, details }`.

## Testing strategy

| Level | What | Notes |
|---|---|---|
| Unit | Adapter request building, prompt builder, chunker, consolidation, key resolution | vitest, mocked SDK |
| Integration | Real LLM calls against DeepSeek (cheap, `base_url` override) — single and chunked reviews | vitest with real `DEEPSEEK_API_KEY`; controlled budget, small fixture |
| Component | Dispatcher routes, message handling (force/stop), status transitions | Redis in container |
| E2E | Full flow on minikube: POST /review → real findings on PR → force/stop → follow-up → idle | Manual / `scripts/e2e-test.sh` (extended) |

Coverage target: 80%+ on shared + dispatcher + reviewer.

**LLM test strategy:** mocks cover adapter request/response shaping and pipeline logic; real-LLM integration tests run against DeepSeek (cheap, OpenAI/Anthropic-compatible) instead of expensive Anthropic/OpenAI APIs. This validates contracts (request shape, structured output) without mock-only blind spots.

## What is NOT in v3 (out-of-scope)

- MCP agentic review (Semble, filesystem tools) — v4
- GitHub webhook (`POST /webhook/github`) — v5; `force`/`stop`/follow-up via `POST /review/:jobId/message` only
- GitHub App installation/auth — v6
- Multi-model hybrid strategy (Haiku triage → Opus deep) — future phase
- Token cost tracking / budget alerts — future phase
- Rate limiting per repo — rejected in brainstorm (budget per review only)
- Fallback between providers on failure — rejected (simple retry only)
- Multi-turn conversation memory in follow-ups — single-turn with review context only
- Dashboard / UI

## Future phases (reference only)

| Phase | Scope |
|---|---|
| v4 — MCP Agentic Review | Semble MCP + filesystem tools inside Pod; `.reviewer-mcp.json` per repo |
| v5 — GitHub Webhook | `POST /webhook/github`, signature validation, auto-trigger, "@reviewer" comment → message routing (reuses force/stop/follow-up handlers) |
| v6 — GitHub App | Installation flow, per-installation tokens, multi-tenant |
| v7 — Deep Context | git log history, pattern comparison, learning from past reviews |
| v8 — Production | Helm chart, monitoring, cost tracking, multi-repo |
