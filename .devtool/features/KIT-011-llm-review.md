---
id: "KIT-011"
status: "backlog"
priority: "high"
assignee: ""
epic: "v3-llm-integration"
dueDate: null
created: "2026-08-03"
modified: "2026-08-03"
completedAt: null
labels: ["llm", "core"]
order: "c1"
---

# LLM Review with Real Findings

## User Story

See [US-011](../../docs/stories/US-011-llm-review.md).

## Technical Refinement

### Files

**Modified (shared):**
- `packages/shared/src/types/reviewer-config.ts` — add `maxContextTokens`, `maxOutputTokens`, `maxFindings`, `maxComplexity` to `ReviewerConfigSchema` (lines 16-26)
- `packages/shared/src/config/defaults.ts` — new `DEFAULT_CONFIG`: `maxContextTokens: 1_000_000`, `maxOutputTokens: 16_000`, `maxFindings: 20`, `maxComplexity: 10`, `model: "deepseek-v4-flash"` (line 8)
- `packages/shared/src/config/parse-config.ts` — `RawReviewerSchema` (lines 13-22) + `toReviewerConfig` (lines 49-60): accept `max_context_tokens`, `max_output_tokens`, `max_findings`, `max_complexity`; **remove** `max_tokens` (breaking — v3 rename)

**Created (shared):**
- `packages/shared/src/llm/anthropic-adapter.ts` — `AnthropicAdapter implements LLMAdapter`

**Modified (reviewer):**
- `packages/reviewer/src/types.ts` — `PipelineResult` (lines 48-58): add `findings: readonly Finding[]`; `PipelineConfig` (lines 37-46): no change needed
- `packages/reviewer/src/pipeline.ts` — replace dry-run call (line 65) with real LLM review; keep clone/diff/files steps (lines 24-48)
- `packages/reviewer/src/github/comment.ts` — new `formatFindingsComment(findings, metadata)`; keep `[KITTEN-TEST]` prefix pattern (line 78)

**Created (reviewer):**
- `packages/reviewer/src/prompt/build-prompt.ts` — `buildReviewPrompt(...)`

### Consumes

- `LLMAdapter` interface (`packages/shared/src/llm/adapter.ts:26`) — `review(context: ReviewContext): Promise<ReviewResult>`
- `ReviewContext` (`adapter.ts:15-20`): `job`, `config`, `files: ReviewFile[]`, `diff?`
- `ReviewFile` (`adapter.ts:5-9`): `{ path, content }`
- `ReviewResult` (`packages/shared/src/types/review-job.ts:37-47`): `findings`, `metadata.model/inputTokens/outputTokens`
- `FindingSchema` (`review-job.ts:23-32`) — shape the tool `input_schema` must match
- `pullRequestFile.patch` (`packages/shared/src/types/pull-request-file.ts:7`) — diff text per file
- `generateDiff` (`packages/reviewer/src/git/diff.ts:11`) — `DiffResult.raw`
- Existing test patterns: `packages/reviewer/tests/analyzer/dry-run.test.ts`, `packages/reviewer/tests/github/comment.test.ts`

### Produces

- `AnthropicAdapter` (constructor: `{ apiKey: string, baseUrl: string }`) — tool use with `input_schema` from `FindingSchema`, `max_tokens: config.maxOutputTokens`
- `buildReviewPrompt(diff: string, files: readonly ReviewFile[], config: ReviewerConfig): { system: string; user: string }` — monolithic guardrailed prompt (US-011 AC-2/AC-4)
- `formatFindingsComment(findings: readonly Finding[], meta: { repo, prNumber, model, inputTokens, outputTokens }): string` — Markdown table body
- `PipelineResult.findings` — populated by the LLM review
- Defaults: `model: "deepseek-v4-flash"`, `baseUrl: "https://api.deepseek.com/anthropic"` in `DEFAULT_CONFIG` (KIT-012 consumes the key resolution)

### Design decisions

1. **Tool use with `input_schema` (not `output_config`)** — Anthropic's newer `output_config.format.json_schema` is NOT supported by the DeepSeek Anthropic endpoint (compat table: "output_config: Only effort is supported" — api-docs.deepseek.com/guides/anthropic_api). Classic tool use works on Anthropic AND DeepSeek. `output_config` deferred as Anthropic-only optimization.
2. **`max_tokens` split into two fields** — `max_context_tokens` (chunking budget, KIT-014) vs `max_output_tokens` (per-request output limit; DeepSeek caps at 384K, Anthropic lower). Passing 1M as request `max_tokens` would exceed output caps.
3. **Default config points at DeepSeek** — user decision: use DeepSeek via Anthropic SDK ("config mais fácil", cheap tests). `DEFAULT_CONFIG.baseUrl = "https://api.deepseek.com/anthropic"`, `model = "deepseek-v4-flash"`. A `.reviewer.yml` with `base_url` absent resolves to the provider's official URL (KIT-012).
4. **Single comment with Markdown table in this card** — inline diff comments are KIT-013. Keeps this card focused on the LLM path.
5. **Retry simple** — 3 attempts, backoff 1s→2s→4s on rate limit/timeout (user decision). No cross-provider fallback.

### Risks

1. **Tool use shape mismatch with DeepSeek Anthropic endpoint** — schema of `tools`/`tool_choice`/`tool_use` in the request must match DeepSeek's compat table. Step 3 (unit test of request shape) verifies before any real call.
2. **Real LLM call not runnable until KIT-012** — this card's integration test needs `DEEPSEEK_API_KEY` resolution (KIT-012). Here: unit tests with mocked SDK only; real-call smoke deferred to KIT-012.
3. **Prompt size vs model context** — monolithic prompt with full diff + files may exceed context for big PRs. Chunking (KIT-014) handles it; this card tests with small fixture only.

## Implementation Plan

1. - [ ] **RED — config schema test**: in `packages/shared/tests/config/parse-config.test.ts`, add tests: YAML with `max_context_tokens: 500000` parses to `maxContextTokens: 500000`; `max_findings: 5` → `maxFindings: 5`; old `max_tokens` key is rejected with `VALIDATION`; empty YAML returns `DEFAULT_CONFIG` with the new defaults. Command: `pnpm --filter @kitten/shared test` — expect the new tests to FAIL (fields not in schema yet).
2. - [ ] **GREEN — config schema**: update `ReviewerConfigSchema`, `RawReviewerSchema`, `toReviewerConfig`, `DEFAULT_CONFIG` per Files above. Run the tests again — expect PASS.
3. - [ ] Commit: `feat(shared): add v3 LLM config fields (max_context/output tokens, max_findings, max_complexity)`
4. - [ ] **RED — prompt builder test**: create `packages/reviewer/tests/prompt/build-prompt.test.ts`. Assert the system prompt contains: review-only scope with "never commit" / "never push"; exact `file:line` requirement; "do not" style/whitespace/praise clauses; "at most {maxFindings}"; complexity threshold `{maxComplexity}`; output contract (respond ONLY with tool call). Given/When/Then per AC-2/AC-4 of US-011. Run: `pnpm --filter @kitten/reviewer test` — FAIL.
5. - [ ] **GREEN — build-prompt.ts**: implement `buildReviewPrompt` per the guardrail list in the epic (`## Monolithic prompt`). Test PASS.
6. - [ ] Commit: `feat(reviewer): add monolithic guardrailed review prompt builder`
7. - [ ] **RED — AnthropicAdapter test**: create `packages/shared/tests/llm/anthropic-adapter.test.ts` mocking `@anthropic-ai/sdk` (`vi.mock`). Assert: request carries `model`, `max_tokens: 16000`, `tools` with `name: "report_findings"` and `input_schema` matching `FindingSchema` (severity enum, file, line, finding, suggestion?, ruleId?), `tool_choice: { type: "tool", name: "report_findings" }`; response `tool_use` block parses into `ReviewResult.findings`; metadata model/inputTokens/outputTokens from usage. Run: FAIL.
8. - [ ] **GREEN — anthropic-adapter.ts**: implement `AnthropicAdapter` with tool use. Test PASS.
9. - [ ] Commit: `feat(shared): add AnthropicAdapter with tool-use structured output`
10. - [ ] **RED — pipeline LLM test**: update `packages/reviewer/tests/pipeline.test.ts`. Mock the LLM result: pipeline returns `status: "completed"` with `findings: [...]` from the adapter; `postReviewComment` receives the formatted findings body (not the v2 dry-run body). Command: FAIL.
11. - [ ] **GREEN — pipeline.ts**: replace dry-run call (line 65) with adapter call + `formatFindingsComment` post. Keep cleanup/finally (lines 99-102). Test PASS.
12. - [ ] Commit: `feat(reviewer): run real LLM review in pipeline and post findings`
13. - [ ] Run full suites: `pnpm test && pnpm lint` — all green.

## How to Test

- **Automated**: `pnpm test` — specifically `packages/shared/tests/config/parse-config.test.ts` (new config fields), `packages/shared/tests/llm/anthropic-adapter.test.ts` (tool use shape), `packages/reviewer/tests/prompt/build-prompt.test.ts` (guardrails), `packages/reviewer/tests/pipeline.test.ts` (LLM in pipeline). All must PASS; the v2 dry-run assertion (placeholder body) must no longer appear in comment tests.
- **Manual verification**: run the reviewer pipeline with a mocked adapter wired via a test fixture repo, or temporarily point `DEFAULT_CONFIG` at DeepSeek with `DEEPSEEK_API_KEY` set: `DEEPSEEK_API_KEY=... node packages/reviewer/dist/index.js` with env vars set → observe logs `[reviewer] LLM review complete: N findings` and a PR comment containing a `| Severity | File | Line | Finding |` table.
- **Negative check**: `.reviewer.yml` containing legacy `max_tokens: 100000` → pipeline fails with `{ code: "VALIDATION" }` naming the unknown key; no LLM call is made (log shows validation failure before "Calling LLM").
- **Done means**: `pnpm test` green; pipeline posts a real findings table comment (mocked SDK) containing `[KITTEN-TEST]`; no dry-run placeholder text ("DRY RUN") appears anywhere in the comment body.
