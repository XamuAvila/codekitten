# US-029 — PR Comment Commands

**As a** developer discussing a review on GitHub,
**I want** to command the reviewer by commenting `@reviewer force`, `@reviewer stop`, or `@reviewer <question>` on the PR
**so that** I control the review where the conversation already lives.

## Acceptance Criteria

### AC-1 — force and stop route to the existing handlers
**Given** an active review job and a PR comment `@reviewer force` (or `stop`) by a human
**When** the webhook delivers the `issue_comment` event
**Then** the same force (or stop) behavior as `POST /review/:jobId/message` runs, answered 202.

### AC-2 — Any other trigger text is a follow-up question
**Given** an active job and a comment `@reviewer why is finding 2 relevant?`
**When** the event arrives
**Then** the text (trigger stripped) is published as a follow-up and the Pod answers on the PR.

### AC-3 — Non-trigger and bot comments are ignored
**Given** a comment without the trigger word, or any comment authored by a bot
**When** the event arrives
**Then** the dispatcher answers 200 `{ ignored: true }` — no message published (bot filter prevents feedback loops).

### AC-4 — Commands on a dead job are acknowledged with no effect
**Given** a comment `@reviewer force` for a PR whose job is terminal or unknown
**When** the event arrives
**Then** the dispatcher answers 200 `{ ignored: true }` and logs the miss (GitHub must not retry).
