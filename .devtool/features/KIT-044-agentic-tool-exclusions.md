---
id: "KIT-044"
status: "backlog"
priority: "high"
assignee: ""
epic: "v8-agent-security-guardrails"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["security", "guardrails", "reviewer", "agentic"]
order: "f3"
---

# Agentic Tool Exclusions: Confinement, semantic_search, find_related

## User Story

See [US-036](../../docs/stories/US-036-review-inputs-respect-exclusions.md) (AC-3).

## Technical Refinement

### Files

**Modified (reviewer):**
- `packages/reviewer/src/mcp/confinement.ts:54-59` — `isExcluded` evolves into the shared matcher. The current `isExcluded(relPath, skipPatterns)` (`.git/` + picomatch) becomes a thin wrapper that also consults the matcher's ignored-path snapshot. Keep the exported name for the existing call sites/tests; add `isExcludedPath(relPath, matcher)` as the authoritative path.
- `packages/reviewer/src/mcp/registry.ts:10-17` — `McpContext` carries the exclusion data: `excludedPaths: ReadonlySet<string>` (from `matcher.ignoredPaths()`) plus the merged pattern list. `createRegistry` (line 46) accepts it; the pipeline passes `matcher` (KIT-043).
- `packages/reviewer/src/mcp/semantic-search.ts:75-84` — **filter sidecar result paths** against the exclusion data before returning to the LLM. Result paths arrive as `path` or `path:line` — strip the `:line` suffix, then `isExcludedPath`. Dropped results are removed; all-dropped → "No results".
- `packages/reviewer/src/mcp/find-related.ts:50-58` — check the target file with the exclusion data before reading (currently only `confinePath`). Excluded target → exclusion error, no read.
- `packages/reviewer/src/mcp/search.ts:128-147` — the tree walk consults the ignored-path snapshot in addition to patterns (the `walk` already takes `skipPatterns`; extend to take the exclusion data).
- `packages/reviewer/src/mcp/search.ts:68` — **hardening for CVE-2026-33672**: the `pathGlob` input is model-controlled (untrusted). Reject globs containing POSIX character classes (`[[:...:]]`) with a `VALIDATION` tool error before compiling with picomatch (the advisory's recommended mitigation for untrusted globs; picomatch is already patched, this is defense-in-depth).

### Consumes

- `ExclusionMatcher` / `buildExclusionMatcher` from `@kitten/shared` (KIT-042).
- `McpContext` construction in `pipeline.ts:156-161` — the merged `skip` list today (`[...reviewerConfig.config.skip, ...mcpConfig.search.skip]`); this card adds the ignored-path snapshot alongside.

### Produces

- Every agentic tool guarantees: an excluded path returns an exclusion error or an empty result; the path never appears in a `tool_result`.
- `search` rejects POSIX-class globs with `{ code: "VALIDATION", message: ... }`.

### Design decisions

1. **Filter at the tool boundary, not the loop** — results are sanitized before becoming `tool_result` (loop.ts:151-154 unchanged). The loop does not know about exclusions; the registry + executors are the enforcement point.
2. **`semantic_search` filtered in the reviewer, not the sidecar** — even after KIT-045 propagates exclusions to the Semble index, the reviewer-side filter is the guarantee that no excluded path reaches the LLM regardless of sidecar state (defense in depth, US-036 AC-3).
3. **Snapshot for sync decisions** — tree walks and `read_file` are synchronous; the once-per-review `ignoredPaths()` set is the mechanism (epic D3). `read_file` on a path not present in the worktree falls back to pattern matching (denylist/skip) — a non-existent `.env` is still rejected via the denylist pattern.
4. **Path format normalization** — Semble returns `path` or `path:line`; parse and test the path part only.

### Risks

1. `semantic_search` snippet content can itself contain a secret even when the path is clean (a snippet is code text) — out of scope here; the answer-level redaction (KIT-047) is the backstop for text leakage. Documented, not fixed here.
2. A large ignored-path snapshot slows the walk's per-file check — the snapshot is a `Set` (O(1) membership); only worktree paths are in it.
3. `find_related` behavior change: an excluded target now returns an exclusion error instead of proceeding — update the tool description (one line) so the model understands.

## Implementation Plan

1. - [ ] RED — `mcp/confinement.test.ts`: `isExcludedPath` with a fixture matcher excludes denylist patterns (`.env`, `*.pem`), snapshot paths (`config.local.yaml` from the fixture), and `.git/`; existing `isExcluded` skip/`.git` tests stay green. FAIL.
2. - [ ] GREEN — confinement + registry context wiring. PASS.
3. - [ ] RED — `mcp/semantic-search.test.ts`: sidecar returns `config.local.yaml:5` (excluded) + `src/app.ts:1` (clean) → only the clean path reaches the model; all-excluded → "No results". FAIL.
4. - [ ] GREEN — result-path filter in `semantic-search.ts`. PASS.
5. - [ ] RED — `mcp/find-related.test.ts`: target is an excluded file → exclusion error, no read. FAIL.
6. - [ ] GREEN — target check in `find-related.ts`. PASS.
7. - [ ] RED — `mcp/search.test.ts`: a `pathGlob` containing `[[:alpha:]]` → `VALIDATION` with a "POSIX character classes" message; a benign glob still works. FAIL.
8. - [ ] GREEN — glob guard + walk snapshot. PASS.
9. - [ ] Full suites: `pnpm test && pnpm lint` green; commit: `feat(reviewer): enforce repo exclusions across agentic tools`

## How to Test

- **Automated**: `pnpm test` — confinement/semantic-search/find-related/search tests green; the agentic loop tests (KIT-023..030) stay green.
- **Manual**: on minikube, an agentic review where the model calls `search`/`read_file`/`semantic_search` on `.env` paths → the tools return exclusion errors/empty results; no excluded path appears in the Pod logs or a tool result.
- **Negative**: a repo-declared `skip` file that matches no denylist/ignore is still readable (only configured exclusions apply); a benign `semantic_search` result and a benign `pathGlob` are unaffected.
- **Done means**: `pnpm test && pnpm lint` exit 0; no agentic tool returns an excluded path or content, and model-supplied globs with POSIX character classes are rejected.
