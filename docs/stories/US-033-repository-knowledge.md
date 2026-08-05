# US-033 — Repository Knowledge

**As a** team using the reviewer,
**I want** to teach it durable repo facts — explicitly (`@reviewer remember …`) and by correcting wrong findings in PR threads
**so that** the same mistake or question does not repeat on every review.

## Acceptance Criteria

### AC-1 — remember stores knowledge
**Given** a PR comment `@reviewer remember we use snake_case in the API layer on purpose`
**When** the webhook delivers it
**Then** the text is stored in the repo's Atlas knowledge collection with a Voyage embedding, `source: "command"`, and the author.

### AC-2 — Corrections on findings become knowledge
**Given** a human reply on a reviewer finding thread explaining why it is wrong
**When** the `pull_request_review_comment` webhook delivers it
**Then** the reply (plus the finding it corrects) is stored with `source: "correction"`.

### AC-3 — Bots and empty content are ignored
**Given** a bot reply or an empty `remember`
**When** the event arrives
**Then** nothing is stored and the delivery is acknowledged.

### AC-4 — Knowledge is off without configuration
**Given** `MONGODB_URI` or `VOYAGE_API_KEY` unset
**When** any knowledge write is attempted
**Then** it is skipped with a warning; nothing errors toward GitHub.
