# US-028 — Automatic Review on PR Events

**As a** developer on a repository watched by the reviewer,
**I want** a review to start automatically when I open, reopen, or push to a pull request
**so that** I get feedback without anyone calling the dispatcher by hand.

## Acceptance Criteria

### AC-1 — Signed webhook triggers a review
**Given** a GitHub `pull_request` webhook (action `opened`) with a valid `X-Hub-Signature-256`
**When** the dispatcher receives it
**Then** a reviewer Pod is created for that repo/PR (same flow as `POST /review`) and the delivery is answered 202.

### AC-2 — Invalid signature is rejected before processing
**Given** a delivery with a missing or wrong signature
**When** the dispatcher receives it
**Then** it answers 401 `{ code: "AUTH_FAILED" }` and no Pod, Redis write, or payload parse happens.

### AC-3 — Irrelevant events are acknowledged, not errored
**Given** a delivery for an unhandled event (e.g. `star`) or unhandled action
**When** the dispatcher receives it
**Then** it answers 200 `{ ignored: true }` and does nothing.

### AC-4 — Missing secret disables the route loudly
**Given** the dispatcher runs without `WEBHOOK_SECRET`
**When** any webhook arrives
**Then** it answers 503 and a boot-time warning documents the missing config.
