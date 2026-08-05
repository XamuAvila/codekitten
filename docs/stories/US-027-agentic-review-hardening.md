# US-027 — Agentic Review Hardening

**As a** repository owner using agentic review,
**I want** the agentic loop to enforce the same budget, retry, cancellation and cost-transparency guarantees as the monolithic path
**so that** enabling `.reviewer-mcp.json` never trades away v3's operational safety.

## Acceptance Criteria

### AC-1 — Context budget guards the agentic prompt
**Given** an agentic review whose initial prompt exceeds `maxContextTokens`
**When** the pipeline builds the agentic prompt
**Then** the diff block is truncated to fit the budget, a warning is logged, and the budget comment inviting `force` is posted; `force` re-runs untruncated.

### AC-2 — Transient LLM failures are retried per turn
**Given** an `explore()` call that fails with a transient error (timeout, 5xx, rate limit)
**When** the loop executes that turn
**Then** the call is retried with the v3 backoff (3 attempts, 1s→2s→4s) and auth failures (401) are never retried.

### AC-3 — Stop produces no misleading PR output
**Given** a `stop` command aborting the loop mid-turn
**When** the pipeline finishes
**Then** no "No issues found" (or any findings) comment is posted for the aborted run; cancellation status and comment come from the existing stop plumbing.

### AC-4 — Token usage is tracked and reported
**Given** a completed agentic review
**When** the pipeline posts comments and returns its result
**Then** input/output tokens summed across all explore turns appear in `ReviewResult.metadata` (not zero), and each turn logs tool name, truncated input, latency and turn tokens to stdout.
