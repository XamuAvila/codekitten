# US-035 — Corrections Become Knowledge

**As a** developer replying to a wrong finding on my PR,
**I want** my correction to be captured as repository knowledge automatically
**so that** the reviewer stops repeating a mistake I already explained once.

## Acceptance Criteria

### AC-1 — A human reply on a finding thread is stored
**Given** a reviewer-posted finding thread and a human reply explaining why the finding is wrong
**When** the `pull_request_review_comment` webhook delivers the reply
**Then** the reply plus an excerpt of the corrected finding are stored with `source: "correction"`, repo, PR and author.

### AC-2 — Only reviewer threads qualify
**Given** a human reply on a thread whose root comment was written by a human
**When** the event arrives
**Then** nothing is stored.

### AC-3 — Bot replies are ignored
**Given** a reply authored by a bot (including the reviewer itself)
**When** the event arrives
**Then** nothing is stored (feedback-loop guard).

## Test reminders

- reply on Kitten finding thread (pass — correction doc in Atlas)
- top-level review comment, not a reply (ignored)
- knowledge client unconfigured (warning, delivery 200)
