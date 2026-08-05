---
id: "KIT-023"
status: "in-progress"
priority: "high"
assignee: ""
epic: "v4-mcp-agentic-review"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["agentic", "core"]
order: "c1"
---

# Agentic Review Opt-In

## User Story

See [US-023](../../docs/stories/US-023-agentic-review-opt-in.md).

## Technical Refinement

### Files

**Created (shared):**
- `packages/shared/src/config/mcp-config.ts` — `MCPConfigSchema` (zod `strictObject`, matching the `.reviewer.yml` strictness pattern in `parse-config.ts:13-29`), `DEFAULT_MCP_CONFIG` (`enabled: false`, all caps), `parseMcpConfig(jsonContent: string): MCPConfig` (empty → `DEFAULT_MCP_CONFIG`; invalid JSON or schema violation → `AppError` code `VALIDATION`)
- Export from `packages/shared/src/config/index.ts` (currently re-exports `defaults.js` + `parse-config.js`) and `packages/shared/src/index.ts`

**Modified (shared):**
- `packages/shared/src/llm/adapter.ts` — add `AgentTurn`, `AgentTool`, `ExploreResult` interfaces and `explore(turn: AgentTurn): Promise<ExploreResult>` to `LLMAdapter` (interface at lines 29-41, alongside `review`/`respond`)
- `packages/shared/src/llm/anthropic-adapter.ts` — implement `explore`: `messages.create` with `tools`, `tool_choice: "auto"` (or `forcedToolChoice` name when set), `thinking: { type: "disabled" }` for the DeepSeek base_url (pattern at lines 48-62); parse all `tool_use` blocks into `toolUses`, text block into `text`, usage into metadata
- `packages/shared/src/llm/openai-adapter.ts` — implement `explore`: Chat Completions with `tools` + `tool_choice: "auto"` (or `{ type: "function", function: { name } }`), parse `tool_calls` into `toolUses`
- `packages/shared/src/types/errors.ts` — add `"LLM_OUTPUT_INVALID"` and `"UNKNOWN_TOOL"` to the `AppErrorCode` union (lines 4-12); these are the only new error codes v4 introduces

**Created (reviewer):**
- `packages/reviewer/src/mcp/confinement.ts` — `confinePath(cloneDir, requestedPath)` (resolve + inside-root check + `fs.realpath` on the parent), `isExcluded(relPath, skipPatterns)` (`.git/` + picomatch on `ReviewerConfig.skip`), per-call cap helpers
- `packages/reviewer/src/mcp/read-file.ts` — `readFileTool: McpTool` (numbered lines, `startLine`/`endLine`, `read.maxLines` + `read.maxFileBytes` caps, `truncated` flag)
- `packages/reviewer/src/mcp/registry.ts` — `McpTool`, `McpContext`, `McpToolResult` interfaces + `createRegistry(cloneDir, skipPatterns, caps)`; registers `readFileTool`
- `packages/reviewer/src/agentic/build-agentic-prompt.ts` — `buildAgenticPrompt(diff, changedFiles, config, conventionsContent, mcpConfig): { system, user }` — v3 system guardrails (`build-prompt.ts:27-74`) + agentic block; user = conventions + rules + diff + changed-file **index** (path, status, patch size), no full contents
- `packages/reviewer/src/agentic/loop.ts` — `runAgenticLoop(adapter, prompt, mcpConfig, opts): Promise<{ findings, toolCalls, hitBudget }>` (turn accounting, tool execution, `tool_result` feedback, finalize turn, AbortSignal)
- `packages/reviewer/src/agentic/index.ts`

**Modified (reviewer):**
- `packages/reviewer/src/pipeline.ts` — add `readMcpConfigFromRepo` next to `readConfigFromRepo` (lines 321-334); after step 4 (line 58): enabled → agentic path (agentic prompt + loop + `consolidateFindings` + `postPrReview`, reusing the existing posting block lines 149-225); else the existing v3 path; `stop`/`force` options flow into the loop
- `packages/reviewer/src/types.ts` — `PipelineResult`: add `mcpConfig?: MCPConfig` and `metadata.toolCalls?: number` (lines 48-64)

### Consumes

- `LLMAdapter` (`adapter.ts:29-41`), `Finding`/`ReviewResult` (`review-job.ts:23-49`), `ReviewerConfig` (`reviewer-config.ts`)
- `parseReviewerConfig`/`DEFAULT_CONFIG` pattern (`parse-config.ts:79-111`, `defaults.ts:6-23`) as the config-parsing precedent
- `consolidateFindings(results, declaredRuleIds)` (`consolidate.ts:19-42`) and `postPrReview(...)` (`review.ts:54-148`) — the unchanged findings contract
- `PipelineOptions.signal` (`pipeline.ts:25-30`), `callWithRetry` (`pipeline/retry.ts`), `estimateTokens` (`chunk.ts:9-11`)
- `ReviewerConfig.skip` (`defaults.ts:20`) as the base skip-pattern set

### Produces

- `MCPConfig`, `DEFAULT_MCP_CONFIG`, `parseMcpConfig` — consumed by KIT-024/025/026 for caps
- `LLMAdapter.explore(turn)` — the multi-turn contract KIT-024/025 tools run under
- `McpTool`/`McpContext`/`McpToolResult` registry + `readFileTool` — KIT-024/025 add tools to the same registry
- `runAgenticLoop(...)` returning `{ findings, toolCalls, hitBudget }` — KIT-026 consumes `toolCalls`/`hitBudget`
- `PipelineResult.mcpConfig` + `metadata.toolCalls`

### Design decisions

1. **Hand-rolled in-process TypeScript tools, not Semble** (brainstorm D1) — read-only by construction, vitest-testable, no Python/image changes. Semble remains swappable behind the same `McpTool` interface in a later phase.
2. **Opt-in via `.reviewer-mcp.json`** (D2) — absent/disabled/invalid → v3 monolithic unchanged. A bad config file logs a warning and fail-safes to monolithic (mirrors the `.reviewer.yml` fallback in `parse-config.ts:79-82`); it must never fail a review.
3. **Loop ends on `report_findings`** — sibling tool_uses in the same turn are ignored (the report is authoritative). Findings flow through the v3 contract unchanged (D6): `consolidateFindings` → `postPrReview`. If zero exploration tools were called before `report_findings` (the model reported without reading/searching anything), a warning is logged: "Agentic review reported without exploring — findings may be weaker than v3 monolithic". The review still completes — this is a quality signal, not a failure.
4. **No-tool-use turns get a nudge** — a text-only model turn appends "Continue exploring or report findings"; a second consecutive text-only turn triggers the finalize turn.
5. **Unknown tool_use names → help the model, don't fail** — a `tool_use` block with a name not in the registry returns a `tool_result` with `{ code: "UNKNOWN_TOOL", message: "Tool 'X' is not available. Available tools: <list>." }`. `UNKNOWN_TOOL` is added to `AppErrorCode` in `errors.ts`. The loop continues — this is a model mistake, not a review failure.
6. **Finalize turn forces reporting** — budget exhausted → one last `explore` with `forcedToolChoice: { name: "report_findings" }`. If the finalize turn produces findings that fail `FindingSchema` parsing, the review fails with `AppError` code `LLM_OUTPUT_INVALID` (new code added to `AppErrorCode` in `errors.ts`). Unlike v3's `parseFindings` which throws a bare `Error` with no structured code, v4 wraps this in `AppError` so the pipeline can distinguish it from transient failures — no retry on invalid output.
7. **`force` reuses `ignoreBudget`** — the v3 flag (`pipeline.ts:26`) makes the loop read `forceMaxTurns` (default 60); verified end-to-end in KIT-026, wired here.
8. **`stop` uses the existing AbortSignal** — checked between turns, mirrors the chunk loop (`pipeline.ts:110-113`).
9. **Agentic prompt carries the diff + a changed-file index, not full contents** — findings keep anchoring to exact diff lines; the model pulls full contents on demand via `read_file`.

### Risks

1. **DeepSeek Anthropic endpoint multi-turn tool-result loops unverified** — v3 verified `tools`/`tool_choice` and `thinking: disabled`, but not repeated `tool_result` turns. Step 12 (integration smoke with real `DEEPSEEK_API_KEY`, small budget) gates the loop before full pipeline wiring.
2. **Model reports prematurely with `tool_choice: auto`** — budget + finalize bound this; observed behavior recorded in the integration test.
3. **Symlink escaping the clone root** — confinement `realpath`-checks the resolved path (covers both `../` traversal and symlinks inside the clone pointing outside, e.g. `clone/lib -> /etc`); unit-tested in `confinement.test.ts`.

## Implementation Plan

1. - [ ] **RED — config test**: create `packages/shared/tests/config/mcp-config.test.ts`. Assert: valid JSON with all fields parses; missing keys fall back to `DEFAULT_MCP_CONFIG`; `enabled` defaults `false`; unknown key → `AppError` `VALIDATION`; invalid JSON → `VALIDATION`; empty string → `DEFAULT_MCP_CONFIG`. Command: `pnpm --filter @kitten/shared test` — expect the new tests to FAIL (module does not exist yet).
2. - [ ] **GREEN — mcp-config.ts**: implement schema + defaults + parser; export from `config/index.ts`. Run tests — PASS.
3. - [ ] Commit: `feat(shared): add MCP config schema for agentic review`
4. - [ ] **RED — explore adapter tests**: extend `packages/shared/tests/llm/anthropic-adapter.test.ts` and `openai-adapter.test.ts`. Assert: `explore` sends the tools array; `tool_choice: "auto"` unless `forcedToolChoice` is set (then the named tool); DeepSeek base_url keeps `thinking: disabled`; `tool_use` blocks parse into `toolUses`; a text-only response returns `toolUses: []`; usage maps to metadata. Command: `pnpm --filter @kitten/shared test` — FAIL.
5. - [ ] **GREEN — explore implementations**: add `explore` to the `LLMAdapter` interface and both adapters. Test PASS.
6. - [ ] Commit: `feat(shared): add explore method for multi-turn tool loops to LLM adapters`
7. - [ ] **RED — confinement test**: create `packages/reviewer/tests/mcp/confinement.test.ts`. Assert: in-root paths resolve; `../`, absolute paths outside, and `.git/**` are rejected; a symlink inside the clone pointing outside (e.g. `clone/escape -> /etc`) → `{ code: "VALIDATION" }` via `fs.realpath` resolution; `ReviewerConfig.skip` patterns excluded; cap helper truncates. Command: `pnpm --filter @kitten/reviewer test` — FAIL.
8. - [ ] **GREEN — confinement.ts**: implement. PASS.
9. - [ ] **RED — read_file test**: create `packages/reviewer/tests/mcp/read-file.test.ts`. Assert: numbered lines with `startLine`/`endLine`; `read.maxLines` cap + `truncated: true`; missing file → `{ code: "NOT_FOUND" }`; escape path → `{ code: "VALIDATION" }`. FAIL.
10. - [ ] **GREEN — read-file.ts + registry.ts**: implement both; register `readFileTool`. PASS.
11. - [ ] Commit: `feat(reviewer): add read-only read_file tool with root confinement`
12. - [ ] **Integration smoke (risk gate)**: extend `packages/reviewer/tests/llm-integration.test.ts` with a small real DeepSeek agentic turn (tool_use → `tool_result` → second turn) to verify multi-turn tool loops on the Anthropic endpoint. If it fails, stop and re-open the design (this gates the whole epic). PASS expected.
13. - [ ] **RED — agentic prompt test**: create `packages/reviewer/tests/agentic/build-agentic-prompt.test.ts`. Assert: system contains the v3 guardrails AND the agentic block (explore first, read-only tools, budget, finish with `report_findings`); user contains the diff + the changed-file index (path, status, size) and NOT full file contents. FAIL.
14. - [ ] **GREEN — build-agentic-prompt.ts**: implement. PASS.
15. - [ ] **RED — loop test**: create `packages/reviewer/tests/agentic/loop.test.ts` with a mocked adapter. Assert: a `tool_use` turn executes the tool and feeds the `tool_result` into the next turn's messages; `report_findings` ends the loop and returns its findings; `report_findings` on turn 1 with zero exploration tools → warning logged, findings returned; `maxTurns` exhausted → finalize turn with `forcedToolChoice: report_findings` and `hitBudget: true`; two consecutive text-only turns trigger finalize; an unknown tool name → `{ code: "UNKNOWN_TOOL" }` tool_result, loop continues; an aborted signal stops the loop; `toolCalls` counts executed tools. FAIL.
16. - [ ] **GREEN — loop.ts + index.ts**: implement. PASS.
17. - [ ] **RED — pipeline branch test**: extend `packages/reviewer/tests/pipeline.test.ts`. Fixture A: `.reviewer-mcp.json` enabled → findings posted through `postPrReview`, `mcpConfig` and `metadata.toolCalls` populated. Fixture B: no file → v3 chunking path, no agentic call. Fixture C: invalid file → status `completed`, v3 path, warning logged. FAIL.
18. - [ ] **GREEN — pipeline.ts + types.ts**: implement the branch and the new `PipelineResult` fields. PASS.
19. - [ ] Commit: `feat(reviewer): run opt-in agentic review loop in pipeline`
20. - [ ] Run full suites: `pnpm test && pnpm lint` — all green.

## How to Test

- **Automated**: `pnpm test` — specifically `packages/shared/tests/config/mcp-config.test.ts`, `packages/shared/tests/llm/{anthropic,openai}-adapter.test.ts`, `packages/reviewer/tests/mcp/{confinement,read-file}.test.ts`, `packages/reviewer/tests/agentic/{build-agentic-prompt,loop}.test.ts`, `packages/reviewer/tests/pipeline.test.ts`, `packages/reviewer/tests/llm-integration.test.ts`. All must PASS; the v3 pipeline tests must remain green unchanged.
- **Manual verification**: on minikube, submit a review on a fixture repo with `.reviewer-mcp.json` (`enabled: true`) → Pod logs show the agentic path ("Agentic loop: N turns, M tool calls") and a real PR review with findings. Submit the same PR with the file removed → logs match the v3 monolithic path and the posted review is identical in shape.
- **Negative check**: `.reviewer-mcp.json` with an unknown key (e.g. `"maxTurns": "not-a-number"` or a bogus field) → review still completes on the v3 path with a logged warning, status `completed`, and no agentic tools offered. A `read_file` call targeting `../../etc/passwd` returns `{ code: "VALIDATION" }` and the Pod reads nothing outside `/tmp/clones/{jobId}`. Tool result content logged to stdout never contains secrets (API keys, tokens, webhook secrets) — verify by grepping Pod logs for known secret patterns after an agentic review.
- **Done means**: `pnpm test && pnpm lint` exit 0; an opt-in fixture repo gets an agentic review whose findings are posted via `postPrReview`; a repo without `.reviewer-mcp.json` produces byte-identical v3 output.
