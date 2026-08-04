---
id: "KIT-014"
status: "done"
priority: "medium"
assignee: ""
epic: "v3-llm-integration"
dueDate: null
created: "2026-08-03"
modified: "2026-08-03"
completedAt: "2026-08-03"
labels: ["llm", "chunking"]
order: "c4"
---

# Chunked Multi-Round Review

## User Story

See [US-014](../../docs/stories/US-014-chunked-multi-round-review.md).

## Technical Refinement

### Files

**Created (reviewer):**
- `packages/reviewer/src/chunker/chunk.ts` — `splitFilesIntoChunks(...)` + `estimateTokens(...)`
- `packages/reviewer/src/chunker/consolidate.ts` — `consolidateFindings(...)`
- `packages/reviewer/src/chunker/index.ts`
- `packages/reviewer/tests/chunker/chunk.test.ts`, `packages/reviewer/tests/chunker/consolidate.test.ts`

**Modified (reviewer):**
- `packages/reviewer/src/pipeline.ts` — budget check before LLM call; multi-round loop; budget question comment
- `packages/reviewer/src/types.ts` — chunk types (`Chunk`, `ChunkResult`)

### Consumes

- `ReviewerConfig.maxContextTokens` (KIT-011, default 1_000_000) — chunking budget
- `ReviewFile` (`packages/shared/src/llm/adapter.ts:5-9`) — `{ path, content }`
- `LLMAdapter.review(context)` (`adapter.ts:26`) — per-chunk call with a `ReviewContext` whose `files` subset is the chunk
- `ReviewResult` (`packages/shared/src/types/review-job.ts:37-47`) — `findings` per chunk
- Token estimation pattern from `dry-run.ts:11` — `Math.ceil(totalChars / 4)`

### Produces

- `estimateTokens(text: string): number` — `Math.ceil(text.length / 4)` (moved/extracted from dry-run)
- `splitFilesIntoChunks(files: readonly ReviewFile[], maxContextTokens: number, basePromptTokens: number): readonly Chunk[]` — `Chunk = { files: readonly ReviewFile[], estimatedTokens: number }`; files sorted largest-first, packed until the budget fills; each chunk carries prompt overhead accounted in `basePromptTokens`
- `consolidateFindings(results: readonly ReviewResult[]): readonly Finding[]` — dedup by `file:line`, keep highest severity on conflict, stable order
- Pipeline behavior: `total > maxContextTokens` → N LLM calls (one per chunk) → consolidated findings → budget question comment (US-014 AC-5)
- Budget question comment body: `PR exceeds the token budget (Nk of {maxContextTokens}). Reply "force" for a full review without limits.`

### Design decisions

1. **Chars/4 heuristic for estimation** — matches existing dry-run (`dry-run.ts:11`). No real tokenizer in v3; chunks are sized with a safety margin (fill to 90% of budget) to absorb drift. Real token counting is a future refinement.
2. **Chunk = prompt overhead + files** — the guardrailed prompt (system + diff + conventions) repeats per chunk; its tokens count toward the budget so a chunk never overflows.
3. **Largest-first packing** — biggest files get their own chunks first (a giant file alone may fill a chunk); smaller files pack together. Prevents one large file from starving the rest.
4. **Dedup by `file:line`** — a file appears in exactly one chunk, so cross-chunk duplicates come from LLM re-reporting; dedup keeps highest severity, drops repeats (US-014 AC-3).
5. **Chunk failure contained** — failed chunk (after KIT-011 retries) is skipped, successful chunks still reported, warning comment added (US-014 AC-4).
6. **Budget question posted after partial findings** — the partial review is not lost; the comment invites `force` (consumed by KIT-015).

### Risks

1. **Estimation drift** — chars/4 under-estimates code (symbols). Safety margin (90%) + per-chunk re-estimation mitigate; overflow during a call fails that chunk only (contained).
2. **Very large single file** — a file larger than the budget alone cannot fit in any chunk; it gets its own chunk regardless (may overflow), and the failure is contained per decision 5. Documented in the plan's test for oversized file.

## Implementation Plan

1. - [ ] **RED — estimateTokens + chunk test**: create `packages/reviewer/tests/chunker/chunk.test.ts`. Cases: files total under budget → one chunk; over budget → multiple chunks, each `estimatedTokens <= budget`; largest-first ordering (a 60%-budget file leads); a single file over budget → its own chunk (may exceed); prompt overhead counted in each chunk. Run: FAIL.
2. - [ ] **GREEN — chunk.ts**: implement `estimateTokens` + `splitFilesIntoChunks`. PASS.
3. - [ ] Commit: `feat(reviewer): add file chunking for token-budget review`
4. - [ ] **RED — consolidate test**: create `packages/reviewer/tests/chunker/consolidate.test.ts`. Cases: identical `file:line` deduped (highest severity wins); different files kept; empty input → empty output; order stable (first occurrence wins). Run: FAIL.
5. - [ ] **GREEN — consolidate.ts**: implement. PASS.
6. - [ ] Commit: `feat(reviewer): consolidate and dedup multi-round findings`
7. - [ ] **RED — pipeline multi-round test**: `packages/reviewer/tests/pipeline.test.ts` — a mocked adapter records one call when under budget, N calls when over (chunk files); consolidated findings posted; budget question comment posted when over; **a chunk whose LLM call fails (after retries) is skipped and the PR comment notes the failed chunk while other findings appear** (US-014 AC-4). Run: FAIL.
8. - [ ] **GREEN — pipeline chunking**: budget check → single call or chunk loop → `consolidateFindings` → `postPrReview` (KIT-013) + budget question comment; failed-chunk warning appended to the posted comment. PASS.
9. - [ ] Commit: `feat(reviewer): multi-round chunked review in pipeline`
10. - [ ] Run: `pnpm test && pnpm lint` — all green.

## How to Test

- **Automated**: `pnpm test` — `packages/reviewer/tests/chunker/chunk.test.ts` (budget packing, largest-first, oversized file), `packages/reviewer/tests/chunker/consolidate.test.ts` (dedup by file:line), `packages/reviewer/tests/pipeline.test.ts` (1 call under budget, N calls over, budget question posted). All PASS.
- **Manual verification**: with `max_context_tokens` set low (e.g. 2000) in the fixture repo's `.reviewer.yml`, run the pipeline on `XamuAvila/kitten-test-repo` PR #1 → logs show `Chunk 1/3 (N files, Mk tokens)`, PR receives a comment containing `PR exceeds the token budget` plus the partial findings review.
- **Negative check**: `.reviewer.yml` with `max_context_tokens: 100` and a PR with a single 10KB file → review still completes (oversized file in its own chunk), other logic unaffected; a chunk whose LLM call fails (mocked) is skipped and the PR comment notes the failed chunk while other findings appear.
- **Done means**: `pnpm test` green; under-budget PR does exactly 1 LLM call; over-budget PR does N calls, dedupes findings, and posts the budget question comment.
