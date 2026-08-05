---
id: "KIT-025"
status: "in-progress"
priority: "medium"
assignee: ""
epic: "v4-mcp-agentic-review"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["agentic", "tools"]
order: "c3"
---

# Related-Code Discovery Tools

## User Story

See [US-025](../../docs/stories/US-025-related-code-tools.md).

## Technical Refinement

### Files

**Created (reviewer):**
- `packages/reviewer/src/mcp/find-related.ts` — `findRelatedTool: McpTool` (extract the identifier at `file:line`, then repo-wide occurrence search → call-sites/usages)
- `packages/reviewer/src/mcp/list-directory.ts` — `listDirectoryTool: McpTool` (one-level entries with dir/file flags)

**Modified (reviewer):**
- `packages/reviewer/src/mcp/registry.ts` — register both tools
- `packages/reviewer/src/agentic/index.ts` — include both in the default enabled-tool set

### Consumes

- `McpTool`/`McpContext` (`registry.ts`, KIT-023); confinement exclusions (`confinement.ts`, KIT-023)
- The search mechanism from `search.ts` (KIT-024) — `find_related` reuses it for occurrence discovery
- `MCPConfig.findRelated.maxResults` and `MCPConfig.listDirectory.maxEntries` (`mcp-config.ts`, KIT-023)

### Produces

- `findRelatedTool` and `listDirectoryTool` registered in the registry; both available to the loop (KIT-023) with results fed back as `tool_result`

### Design decisions

1. **`find_related` is symbol/usage-based, not semantic** (brainstorm D1) — extract an identifier near the given line, then reuse the `search` mechanism for repo-wide occurrences. This is the call-site analysis primitive v4 promises; embedding-based related-code search is deferred to v7 Deep Context.

   **Identifier extraction algorithm:**
   - Read the target line from the file at `cloneDir/file`.
   - Tokenize by identifier-charset (`[a-zA-Z0-9_]+`).
   - Reject tokens that are purely numeric (no `[a-zA-Z]`) — numeric literals are not identifiers.
   - Filter out language-reserved keywords. The keyword list targets JS/TS, which covers Kitten's own stack and is the most common white-label language; other languages are best-effort (non-filtered keywords from the target language may be picked, but the model sees which identifier was used and can retry with `search` directly). Keywords: `const`, `let`, `var`, `function`, `class`, `import`, `export`, `return`, `if`, `else`, `for`, `while`, `do`, `switch`, `case`, `break`, `continue`, `throw`, `try`, `catch`, `finally`, `new`, `this`, `super`, `typeof`, `instanceof`, `void`, `delete`, `in`, `of`, `async`, `await`, `yield`, `true`, `false`, `null`, `undefined`, `type`, `interface`, `enum`, `implements`, `extends`, `static`, `public`, `private`, `protected`, `readonly`, `abstract`, `default`, `as`, `from`, `get`, `set`.
   - Pick the **longest** remaining token (most specific identifier).
   - Ties → prefer the token closest to the **start** of the line (leftmost).
   - The tool result includes the extracted identifier name so the model can validate or retry with a different line.

   This is a best-effort heuristic — the model sees which identifier was used and can call `search` directly if the extraction is wrong (US-025 AC-2).
2. **Graceful degradation** — no identifier at the line → a helpful message ("no identifier found at file:line") rather than an error (US-025 AC-2); identifier with no other occurrences → "no other occurrences". The loop must never die from a tool miss.
3. **`list_directory` is one level, capped** — immediate entries only, `maxEntries` cap (default 100) with `truncated: true`; no recursion (the model can recurse by calling again — that is what the turn budget is for).
4. **Both confined like every tool** — reuse the same root confinement and skip/.git exclusions, so no new attack surface.
5. **Snippet = surrounding lines** — each occurrence returns a short snippet (contextLines from search caps) so the model sees the call-site shape without a full `read_file`.

### Risks

1. **Identifier extraction false positives** — a line like `// uses sendEmail` would extract a token inside a comment. Mitigated by preferring identifier-charset tokens and by the tool reporting which identifier it searched, so the model can correct course. Acceptable for a tool result (the model filters).
2. **Large fan-in symbols (e.g. a util imported everywhere)** — occurrence list capped by `findRelated.maxResults` with `truncated: true`; the model reads the top hits.

## Implementation Plan

1. - [ ] **RED — find_related test**: create `packages/reviewer/tests/mcp/find-related.test.ts`. Assert: an identifier at `file:line` is extracted (longest non-keyword token with at least one letter, ties → leftmost) and repo-wide occurrences return `file:line` + snippet, capped at `findRelated.maxResults` with `truncated: true`; a line with only keywords (`const`, `function`, `return`) → "no identifier found" message, not an error; a line with a numeric literal as the longest token (`version = 20260805`) → extracts `version` (8 chars, has letters), not `20260805` (8 chars, numeric-only); a line with no identifier-like tokens → same; an identifier with no other occurrences → "no other occurrences"; escape path → `{ code: "VALIDATION" }`. Command: `pnpm --filter @kitten/reviewer test` — FAIL.
2. - [ ] **GREEN — find-related.ts**: implement extraction + occurrence search (reusing `search.ts`); register in `registry.ts` and the default tool set. Test PASS.
3. - [ ] **RED — list_directory test**: create `packages/reviewer/tests/mcp/list-directory.test.ts`. Assert: one-level entries with dir/file flags; `maxEntries` cap + `truncated: true`; missing dir → `{ code: "NOT_FOUND" }`; escape path → `{ code: "VALIDATION" }`; `.git` never listed. FAIL.
4. - [ ] **GREEN — list-directory.ts**: implement; register. PASS.
5. - [ ] Commit: `feat(reviewer): add find_related and list_directory tools to the agentic loop`
6. - [ ] **RED — loop integration**: extend `packages/reviewer/tests/agentic/loop.test.ts` — `find_related` and `list_directory` results reach the next turn's messages, and a tool error inside either does not end the review. FAIL.
7. - [ ] **GREEN** — confirm the loop passes tool results through generically (KIT-023) and the test passes. PASS.
8. - [ ] Commit: `test(reviewer): verify related-code tools feed the agentic loop`
9. - [ ] Run full suites: `pnpm test && pnpm lint` — all green.

## How to Test

- **Automated**: `pnpm test` — `packages/reviewer/tests/mcp/find-related.test.ts`, `packages/reviewer/tests/mcp/list-directory.test.ts`, `packages/reviewer/tests/agentic/loop.test.ts`. All PASS.
- **Manual verification**: on minikube with a fixture repo where a PR changes a function signature, watch the Pod logs — the model calls `find_related` on the changed function, reads a caller found outside the diff, and the posted review contains a finding about a missed call-site. A `list_directory` call returns the repo layout before a search.
- **Negative check**: `find_related("src/auth.ts", 9999)` (line beyond file) returns a helpful miss message, not an error, and the review completes; a `list_directory("../../..")` returns `{ code: "VALIDATION" }` and reads nothing outside the clone.
- **Done means**: `pnpm test && pnpm lint` exit 0; `find_related` returns capped repo-wide occurrences with snippets, `list_directory` returns capped one-level entries, and neither tool can fail or escape the review.
