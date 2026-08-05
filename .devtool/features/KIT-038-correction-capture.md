---
id: "KIT-038"
status: "backlog"
priority: "medium"
assignee: ""
epic: "v7-deep-context"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["deep-context", "knowledge", "webhook"]
order: "e4"
---

# Correction Capture (finding thread replies → knowledge)

## User Story

See [US-035](../../docs/stories/US-035-corrections-become-knowledge.md).

## Technical Refinement

**Modified (dispatcher):**
- `packages/dispatcher/src/webhook/events.ts` — new event branch
  `pull_request_review_comment` (action `created`): the comment must be a
  REPLY (`in_reply_to_id` present) on a thread whose root comment was
  authored by the reviewer bot (root body carries the Kitten marker —
  `🐱 **Kitten` prefix used by all posted findings) and the reply author must
  be human. Stored via `KnowledgeClient.insert` as
  `text: "Finding: <root excerpt>\nCorrection: <reply>"`,
  `source: "correction"`, with repo/PR/author.
- Root-comment lookup: one GitHub API call (`GET pulls/comments/{in_reply_to_id}`)
  using the dispatcher's `GITHUB_TOKEN`.

**Consumes:** signature/route/router (KIT-031/032), `KnowledgeClient` (KIT-037), bot filter pattern (KIT-033).

**Decisions:**
1. Only REPLIES on reviewer threads qualify — a human's own top-level comments are not corrections.
2. Every human reply on a finding thread is stored (no sentiment parsing in v7) — retrieval similarity + the LLM decide relevance at use time; over-capture is cheaper than NLP-filtering wrongly.
3. Marker check on the root comment prevents capturing replies on human threads.

**Risks:** GitHub API call per reply adds latency/quota — one call, only for replies that pass the cheap filters first.

## Implementation Plan

1. - [ ] RED: `webhook-events.test.ts` — human reply on a Kitten root → insert with `source: "correction"` and combined text; reply on human thread → ignored; bot reply → ignored; non-reply → ignored; no client → warning + 200. FAIL.
2. - [ ] GREEN: event branch + root lookup (mocked Octokit). PASS.
3. - [ ] Commit: `feat(dispatcher): capture human corrections on findings as knowledge`
4. - [ ] `pnpm test && pnpm lint` green.

## How to Test

- **Automated**: `pnpm test` — extended webhook tests green.
- **Manual**: real/simulated reply on a finding thread → Atlas doc with `source: "correction"`.
- **Negative**: reply by the bot itself → nothing stored; reply on a human comment thread → nothing stored.
- **Done means**: `pnpm test && pnpm lint` exit 0; only human replies on Kitten finding threads become knowledge.
