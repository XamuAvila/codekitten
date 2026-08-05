---
id: "KIT-024"
status: "done"
completedAt: "2026-08-05"
priority: "high"
assignee: ""
epic: "v4-mcp-agentic-review"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["agentic", "tools"]
order: "c2"
---

# Repository-Wide Search Tool

## User Story

See [US-024](../../docs/stories/US-024-repo-search-tool.md).

## Technical Refinement

### Files

**Created (reviewer):**
- `packages/reviewer/src/mcp/search.ts` — `searchTool: McpTool` (regex search over the clone, honoring skip patterns and `.git` exclusion; capped results with context lines; `truncated` flag)

**Modified (reviewer):**
- `packages/reviewer/src/mcp/registry.ts` — register `searchTool` alongside `readFileTool` (KIT-023). No other file needed: the default enabled-tool set lives in `MCPConfig.tools` (`packages/shared/src/config/mcp-config.ts`) and the registry filters by it — the planned `agentic/index.ts` edit was unnecessary (docs-alignment, 2026-08-05).

### Consumes

- `McpTool`/`McpContext` (`registry.ts`, KIT-023) — `ctx.skipPatterns` (merged `ReviewerConfig.skip` + `MCPConfig.search.skip`), `ctx.caps.search` (`maxResults`, `contextLines`, `caseSensitive`)
- Confinement exclusions (`confinement.ts`, KIT-023) — `.git/` + skip patterns + root confinement
- `MCPConfig.search` caps from `mcp-config.ts` (KIT-023)

### Produces

- `searchTool` — `{ name: "search" }` in the registry; the loop (KIT-023) feeds its results back as `tool_result` so the model can act on them

### Design decisions

1. **Lexical regex search in-process, not `rg` and not Semble** — the reviewer image is `node:20-alpine` (`packages/reviewer/Dockerfile:21-29`) with no `rg`; a JS regex walk keeps the image unchanged and the tool vitest-testable. `rg`/Semble remain future optimizations. Per-repo performance is bounded by `maxResults` + `contextLines` + read caps.
2. **Skip patterns merged** — `MCPConfig.search.skip` is additive to `ReviewerConfig.skip`, so a repo can narrow search without touching `.reviewer.yml`.
3. **Empty match set is a normal result** — "no results found" content, not an error, so the loop continues (US-024 AC-5).
4. **Result cap with `truncated: true`** — matches the `read_file` contract (US-024 AC-2) so downstream consumers can detect truncation uniformly.
5. **Binary/large files skipped** — a file exceeding the read cap is skipped rather than partially matched (avoids matching garbage).

### Risks

1. **Performance on very large repos** — a full-tree JS regex walk is slower than `rg`. Mitigated by caps, skip defaults (`**/node_modules/**`, etc.), and the `maxFileBytes` read cap; documented as a future `rg`/Semble optimization.
2. **Regex pitfalls from model-written queries** — a catastrophic-backtracking pattern could hang the walk inside a single `exec()` call (step-count bailout is ineffective: backtracking happens within one call). Mitigated with a **per-search wall-clock timeout** (2s, checked between `exec()` calls via `Date.now()`; `code: "VALIDATION"` with timeout message on expiry) as the primary guard, plus a step-count bailout (max 100k `RegExp.exec` iterations) as a secondary backstop for non-backtracking runaway queries, plus a query-length cap (500 chars), and the existing invalid-regex guard (`code: "VALIDATION"` with the regex error message).

## Implementation Plan

1. - [ ] **RED — search tool test**: create `packages/reviewer/tests/mcp/search.test.ts`. Assert: matches return `file:line: text` with `contextLines`; skip patterns and `.git/` are excluded; `caseSensitive` honored; results capped at `maxResults` with `truncated: true` when exceeded; no matches → "no results" content, not an error; a malformed regex → `{ code: "VALIDATION" }`; a catastrophic-backtracking regex (e.g. `(a+)+b` on 50 'a's) → `{ code: "VALIDATION" }` with timeout message within 2s; query longer than 500 chars → `{ code: "VALIDATION" }`; a path escaping the clone root → `{ code: "VALIDATION" }`. Command: `pnpm --filter @kitten/reviewer test` — FAIL.
2. - [ ] **GREEN — search.ts**: implement the regex walker with a per-search wall-clock timeout (2s, checked via `Date.now()` between `exec()` calls — `code: "VALIDATION"` on expiry) as the primary ReDoS guard, plus a step-count bailout (max 100k `RegExp.exec` iterations) as a secondary backstop for non-backtracking runaway queries, plus query-length cap (500 chars); register in `registry.ts` and the default tool set. Run the test — PASS.
3. - [ ] Commit: `feat(reviewer): add repo-wide search tool to the agentic loop`
4. - [ ] **RED — loop integration**: extend `packages/reviewer/tests/agentic/loop.test.ts` — a turn that calls `search` returns results in the next turn's messages (US-024 AC-4). FAIL.
5. - [ ] **GREEN** — the loop already feeds generic `tool_result` (KIT-023); confirm search results flow through and the test passes. PASS.
6. - [ ] Commit: `test(reviewer): verify search results feed back into the agentic loop`
7. - [ ] Run full suites: `pnpm test && pnpm lint` — all green.

## How to Test

- **Automated**: `pnpm test` — `packages/reviewer/tests/mcp/search.test.ts` and `packages/reviewer/tests/agentic/loop.test.ts`. All PASS; the existing agentic loop tests stay green.
- **Manual verification**: on minikube with a fixture repo, watch the Pod logs during an agentic review — the model's `search` calls return `file:line` matches and a finding anchored to a searched line (e.g. a signature change missed by the diff-only path) appears in the posted review.
- **Negative check**: `.reviewer-mcp.json` with `search.caseSensitive: true` makes a lower-case query miss; a `search` over a skipped pattern (`**/node_modules/**`) returns no results; a query with an invalid regex returns `{ code: "VALIDATION" }` and the loop continues without failing the review; a catastrophic-backtracking regex (`(a+)+b`) returns `{ code: "VALIDATION" }` within 2s (wall-clock timeout between `exec()` calls, not a hung process); a query longer than 500 chars returns `{ code: "VALIDATION" }`.
- **Done means**: `pnpm test && pnpm lint` exit 0; a `search` call from the loop returns capped `file:line` results honoring skip + case + cap, and those results reach the next turn's messages.
