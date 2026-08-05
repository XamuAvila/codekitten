---
id: "KIT-037"
status: "backlog"
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

1. - [ ] Research: Voyage + Atlas current docs (Context7); record model/dims/index JSON here.
2. - [ ] RED: `packages/shared/tests/knowledge/client.test.ts` — mocked driver/fetch: insert embeds + writes shaped doc; search issues vector query; unconfigured → undefined client. FAIL.
3. - [ ] GREEN: client. PASS.
4. - [ ] RED: dispatcher `webhook-events.test.ts` — `@reviewer remember X` → insert called with source command/author; empty text ignored; no client → ignored + warning; bot ignored (existing filter). FAIL.
5. - [ ] GREEN: command wiring. PASS.
6. - [ ] Integration (skipped without secrets): real Voyage embed + Atlas roundtrip insert→search.
7. - [ ] Commit: `feat: knowledge store (Atlas+Voyage) with @reviewer remember command`
8. - [ ] `pnpm test && pnpm lint` green.

## How to Test

- **Automated**: `pnpm test`; integration suite with real secrets exits green.
- **Manual**: simulated `remember` delivery → document visible in Atlas with embedding.
- **Negative**: `@reviewer remember` (empty) → nothing stored; dispatcher without `MONGODB_URI` → warning, delivery 200.
- **Done means**: `pnpm test && pnpm lint` exit 0; remember→Atlas roundtrip proven against the real services.
