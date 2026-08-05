---
id: "KIT-037"
status: "in-progress"
priority: "high"
assignee: ""
epic: "v7-deep-context"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["deep-context", "knowledge"]
order: "e3"
---

# Knowledge Store (Atlas + Voyage) + remember Command

## User Story

See [US-033](../../docs/stories/US-033-repository-knowledge.md) (AC-1, AC-3, AC-4).

## Technical Refinement

**RESEARCH FIRST:** current Voyage embeddings API (code model name, dims,
endpoint) and Atlas Vector Search index definition via Context7 — never from
memory.

**Research findings (2026-08-05, Context7 + official Voyage/MongoDB docs):**
- Voyage: model **`voyage-code-3`**, `POST https://api.voyageai.com/v1/embeddings`, `Authorization: Bearer $VOYAGE_API_KEY`, body `{model, input: [text], input_type: "document"|"query", output_dimension}`. Default dims **1024** (256/512/1024/2048 supported); context 32k tokens/input, truncation on by default. Response `{data: [{embedding: number[]}], usage}` (OpenAI-compatible).
- Atlas: index type `vectorSearch`, definition `{fields: [{type: "vector", path: "embedding", numDimensions: 1024, similarity: "cosine"}, {type: "filter", path: "repo"}]}`; created via `collection.createSearchIndex(name, "vectorSearch", definition)` (node driver v6+, build async). Query: `$vectorSearch` first stage `{index, path, queryVector, numCandidates (≈20× limit), limit, filter: {repo}}`, score via `{$meta: "vectorSearchScore"}` (0..1). Vector search requires an Atlas cluster (historically M10+; unverified whether free tier supports it in 2026).

**Created (shared):**
- `packages/shared/src/knowledge/client.ts` — `KnowledgeClient`: `insert({repo, text, source, author, prNumber?})` (embeds via Voyage REST, writes to Atlas `knowledge` collection) and `search(repo, queryText, topK)` (vector search). Constructed from `MONGODB_URI` + `VOYAGE_API_KEY`; `createKnowledgeClient(env): KnowledgeClient | undefined` — undefined when unconfigured (callers skip with warning).
- `packages/shared/src/knowledge/index.ts`; export from shared index.
- Atlas index definition documented in the module header (created once per deployment; setup script step in KIT-040).

**Modified (dispatcher):**
- `packages/dispatcher/src/webhook/events.ts` — comment command parser gains `remember <text>`: non-empty text → `knowledgeClient.insert(...)` with `source: "command"`; empty → ignored + log; client undefined → ignored + warning. Answer `{ status: "stored" }`.
- `packages/dispatcher/src/server.ts` / `index.ts` — construct the client from env, thread into `EventRouterDeps`.
- K8s/compose env: `MONGODB_URI`, `VOYAGE_API_KEY` (optional secretKeyRef).

**Decisions:**
1. Client lives in shared — KIT-038 (dispatcher) and KIT-039 (reviewer) reuse it.
2. Dispatcher writes directly — `remember` must work without a live Pod.
3. New deps: `mongodb` official driver (shared). Voyage via plain `fetch` (no SDK dep).
4. `remember` does NOT require an active review job — knowledge is repo-scoped, not job-scoped.

**Risks:** embedding latency in the webhook handler — acceptable (single call); if GitHub timeout becomes real, move to fire-and-forget.

## Implementation Plan

1. - [x] Research: Voyage + Atlas current docs (Context7); record model/dims/index JSON here.
2. - [x] RED: `packages/shared/tests/knowledge/client.test.ts` — mocked driver/fetch: insert embeds + writes shaped doc; search issues vector query; unconfigured → undefined client. FAIL.
3. - [x] GREEN: client. PASS.
4. - [x] RED: dispatcher `webhook-events.test.ts` — `@reviewer remember X` → insert called with source command/author; empty text ignored; no client → ignored + warning; bot ignored (existing filter). FAIL.
5. - [x] GREEN: command wiring. PASS.
6. - [ ] Integration (skipped without secrets): real Voyage embed + Atlas roundtrip insert→search.
7. - [x] Commit: `feat: knowledge store (Atlas+Voyage) with @reviewer remember command`
8. - [x] `pnpm test && pnpm lint` green (unit level).

**BLOCKED on step 6:** integration roundtrip needs real `MONGODB_URI` + `VOYAGE_API_KEY` in `.env` (absent as of 2026-08-05). Suite `packages/shared/tests/knowledge/integration.test.ts` is written and skips without secrets. Card stays in-progress until it runs green against real services.

## How to Test

- **Automated**: `pnpm test`; integration suite with real secrets exits green.
- **Manual**: simulated `remember` delivery → document visible in Atlas with embedding.
- **Negative**: `@reviewer remember` (empty) → nothing stored; dispatcher without `MONGODB_URI` → warning, delivery 200.
- **Done means**: `pnpm test && pnpm lint` exit 0; remember→Atlas roundtrip proven against the real services.
