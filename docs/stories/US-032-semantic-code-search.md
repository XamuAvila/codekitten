# US-032 — Semantic Code Search

**As a** repository owner using agentic review,
**I want** the reviewer to find semantically related code (same behavior, different names) via a persistent per-repo index
**so that** pattern-consistency findings stop depending on lexical luck.

## Acceptance Criteria

### AC-1 — semantic_search returns semantically related snippets
**Given** a Pod with a healthy Semble sidecar
**When** the model calls `semantic_search("token validation logic")`
**Then** it receives capped `file:line` snippets ranked by semantic similarity from the indexed clone.

### AC-2 — Index persists across runs, keyed by base branch
**Given** a repo reviewed before on the same base branch
**When** a new review starts
**Then** the sidecar reuses the PVC index (incremental update), and a base-branch change triggers re-index.

### AC-3 — Sidecar failure falls back to lexical tools
**Given** the sidecar is down or unhealthy
**When** `semantic_search` is called
**Then** the tool result says the capability is unavailable and points to `search`/`find_related`; the review completes normally.
