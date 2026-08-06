# US-038 — Follow-Ups Never Leak Secrets

**As a** repository owner using the reviewer,
**I want** answers to follow-up questions to never expose repository secrets
**so that** a question ("what's in the .env?") cannot exfiltrate secrets publicly onto the PR.

## Acceptance Criteria

### AC-1 — Follow-up messages are capped
**Given** a follow-up message exceeding the configured cap (HTTP route or webhook)
**When** it is submitted
**Then** it is rejected (schema VALIDATION 400 on the route; ignored delivery on the webhook) — oversized prompts cannot be forced into the LLM.

### AC-2 — The answer is redacted before posting
**Given** a follow-up whose LLM answer contains a detected secret pattern (from knowledge, conventions, or the diff context)
**When** the answer is posted to the PR
**Then** the matched secrets are masked before `postFollowUpAnswer`, and the post still succeeds.

### AC-3 — The question is not echoed in full in logs
**Given** a follow-up message
**When** the Pod logs it
**Then** only a truncated preview (with the sender) appears, never the full message.

## Test reminders

- `FollowUpMessageSchema` cap enforced on `POST /review/:jobId/message` and the webhook path
- redactor applied to the model answer before posting; masked value shows `***` and the pattern family
- benign answers pass through unchanged
