# US-031 — Git History Tools

**As a** repository owner using agentic review,
**I want** the reviewer to consult a file's git history and line authorship during exploration
**so that** findings weigh churn and age ("this changed 5 times this month") instead of treating all code as equally fresh.

## Acceptance Criteria

### AC-1 — git_log returns recent commits for a path
**Given** an agentic review with history tools enabled
**When** the model calls `git_log("src/auth.ts")`
**Then** it receives up to the capped number of commits (hash, author, date, subject) for that path, root-confined.

### AC-2 — git_blame returns line authorship for a range
**Given** a call `git_blame("src/auth.ts", 10, 20)`
**When** the tool executes
**Then** each line in the range comes back with commit hash, author, and date; caps and `truncated` flag match the v4 tool contract.

### AC-3 — Misses degrade gracefully
**Given** a path outside the clone, an excluded path, or a file with no history
**When** either tool is called
**Then** the result is a structured tool error (`VALIDATION`/`NOT_FOUND`) and the loop continues.
