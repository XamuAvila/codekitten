# US-037 — Knowledge Store Rejects Secrets

**As a** repository owner using the reviewer,
**I want** comments that contain secret material to never be stored as repository knowledge
**so that** a pasted token or credential cannot be embedded and injected into every future review prompt.

## Acceptance Criteria

### AC-1 — `remember` with a secret is rejected
**Given** a `@reviewer remember <text>` comment whose text contains a detected secret pattern (e.g. `ghp_...`, `sk-...`, `AKIA...`, a URL with credentials)
**When** the issue_comment webhook delivers it
**Then** nothing is stored in Atlas, the delivery is acked as ignored, and a warning is logged (the secret value itself is never logged).

### AC-2 — A correction containing a secret is rejected
**Given** a human reply on a finding thread whose body contains a detected secret pattern
**When** the `pull_request_review_comment` webhook delivers it
**Then** nothing is stored, and the delivery is acked as ignored.

### AC-3 — Legitimate knowledge still flows
**Given** a `remember`/correction without secret patterns
**When** the webhook delivers it
**Then** it is stored exactly as before (source, author, PR metadata intact).

### AC-4 — Defense in depth at the client seam
**Given** any caller attempting `knowledgeClient.insert` with secret-bearing text (including future callers)
**When** the insert is attempted
**Then** the client itself rejects it, so the guard cannot be bypassed by a new write path.

## Test reminders

- each secret pattern family detected (GitHub, OpenAI/Anthropic/DeepSeek/Voyage, AWS, URL credentials, `KEY=value`)
- rejection logs the pattern family, never the secret value
- false positives on benign prose (e.g. `sk-` inside a word) are minimized by anchored patterns
