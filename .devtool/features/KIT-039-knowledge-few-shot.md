---
id: "KIT-039"
status: "backlog"
priority: "high"
assignee: ""
epic: "v7-deep-context"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["deep-context", "knowledge", "prompt"]
order: "e5"
---

# Knowledge Few-Shot in the Review Prompt

## User Story

See [US-034](../../docs/stories/US-034-knowledge-calibrated-reviews.md).

## Technical Refinement

**Created (reviewer):**
- `packages/reviewer/src/prompt/knowledge-block.ts` — `buildKnowledgeBlock(entries): string` ("Repository knowledge:" + numbered entries with source/author) and `fetchKnowledge(client, repo, diff, topK): Promise<entries>` (embeds/queries via `KnowledgeClient.search`; failure → empty + warning).

**Modified (reviewer):**
- `packages/reviewer/src/pipeline.ts` — before prompt building: `createKnowledgeClient(env)`; entries fetched once; block appended to the user prompt of BOTH paths (monolithic `buildReviewPrompt` conventions slot and agentic `buildAgenticPrompt`).
- `packages/reviewer/src/prompt/build-prompt.ts` / `agentic/build-agentic-prompt.ts` — optional `knowledgeBlock?: string` parameter rendered above the diff.
- Reviewer Pod manifest env: `MONGODB_URI`, `VOYAGE_API_KEY` (optional secretKeyRef, same secrets as dispatcher).
- System guardrail line: knowledge entries calibrate (drop known-intentional findings, respect conventions) but never relax the precision guardrails.

**Decisions:**
1. topK default 5, config `knowledge: { topK }` in `.reviewer-mcp.json`? NO — knowledge applies to both paths, so it lives in `.reviewer.yml` (`knowledge_top_k`, default 5, additive to `ReviewerConfig`).
2. Query text = the diff (truncated to Voyage input limit) — simplest relevance anchor.
3. Retrieval failure NEVER fails the review (epic error table).

**Risks:** prompt growth — entries capped (topK × content length cap at insert time).

## Implementation Plan

1. - [ ] RED: `tests/prompt/knowledge-block.test.ts` — block formatting; fetch success/empty/error paths (mocked client). FAIL.
2. - [ ] GREEN: module. PASS.
3. - [ ] RED: pipeline tests — with mocked client, both paths carry the block; unset env → no block, no warning noise; client error → warning + review completes. FAIL.
4. - [ ] GREEN: pipeline + prompt wiring + `knowledge_top_k` config. PASS.
5. - [ ] Commit: `feat(reviewer): inject repository knowledge as few-shot review context`
6. - [ ] `pnpm test && pnpm lint` green.

## How to Test

- **Automated**: `pnpm test` — new + existing prompt/pipeline suites green.
- **Manual**: store a `remember`, run a review → Pod log shows the knowledge block; a finding contradicting stored knowledge disappears vs a run without it.
- **Negative**: Atlas down mid-review → warning, review posts normally.
- **Done means**: `pnpm test && pnpm lint` exit 0; knowledge measurably reaches both prompt paths and cannot break a review.
