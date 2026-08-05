# US-034 — Knowledge-Calibrated Reviews

**As a** team using the reviewer,
**I want** every review to start from the repo's accumulated knowledge
**so that** findings respect known conventions and previously corrected mistakes.

## Acceptance Criteria

### AC-1 — Relevant knowledge enters the prompt
**Given** stored knowledge semantically related to the PR diff
**When** a review starts (monolithic or agentic)
**Then** the top-K entries appear in a "Repository knowledge" prompt block, and a previously corrected false positive is not reported again.

### AC-2 — Empty or unavailable knowledge is silent
**Given** no stored knowledge, or Atlas unreachable
**When** a review starts
**Then** the prompt has no knowledge block (or an empty one), a warning is logged on failure, and the review proceeds unchanged.

### AC-3 — End-to-end learning loop
**Given** a `remember` (or correction) captured on PR #N
**When** the next review runs on the same repo
**Then** the Pod logs show the knowledge block with that entry and the posted review reflects it.
