# US-033 — Teach the Reviewer Explicitly

**As a** tech lead using the reviewer on my repository,
**I want** to record a durable repo fact by commenting `@reviewer remember <text>` on any PR
**so that** conventions and intentional decisions stop being re-litigated on every review.

## Acceptance Criteria

### AC-1 — remember stores knowledge
**Given** a PR comment `@reviewer remember we use snake_case in the API layer on purpose`
**When** the webhook delivers it
**Then** the text is stored in the repo's Atlas knowledge collection with a Voyage embedding, `source: "command"`, and the author.

### AC-2 — Empty remember is ignored
**Given** a comment `@reviewer remember` with no text
**When** the event arrives
**Then** nothing is stored and the delivery is acknowledged with a log.

### AC-3 — Knowledge is off without configuration
**Given** `MONGODB_URI` or `VOYAGE_API_KEY` unset
**When** a remember arrives
**Then** the write is skipped with a warning; nothing errors toward GitHub.

## Test reminders

- remember with rich text (pass — doc in Atlas with embedding)
- remember from a bot account (ignored — v5 bot filter)
- remember on a plain issue, not a PR (ignored)
