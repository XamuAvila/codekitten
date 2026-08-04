---
id: "KIT-021"
status: "backlog"
priority: "medium"
assignee: ""
epic: "v3-llm-integration"
dueDate: null
created: "2026-08-04"
modified: "2026-08-04"
completedAt: null
labels: ["chore", "lint", "debt", "needs-refinement"]
order: "c11"
---

# Fix Pre-Existing Lint Errors

## User Story

None yet — this is a chore, not a slice of user value. Per AGENTS.md a card
needs a linked story plus a refinement before it moves to In Progress; both are
outstanding. Discovered while closing [KIT-018](done/KIT-018-custom-review-rules.md),
recorded immediately rather than left in someone's head.

## Problem

`pnpm lint` exits 1. It already exited 1 on `master` at commit `c374c4d`, before
the `feat/v3-orphan-config-fields` branch existed — this is inherited debt, not a
regression from any v3 follow-up card.

47 errors across three files:

| File | Errors | Rules |
|---|---|---|
| `packages/reviewer/tests/agent.test.ts` | 42 | 41× `@typescript-eslint/no-explicit-any`, 1× `no-unused-vars` |
| `packages/reviewer/tests/redis/pubsub.test.ts` | 4 | 3× `@typescript-eslint/no-explicit-any`, 1× `no-unused-vars` |
| `packages/dispatcher/src/middleware/error-handler.ts` | 1 | 1× `@typescript-eslint/no-unused-vars` |

Why it matters beyond tidiness: AGENTS.md lists `pnpm lint` in the local setup
loop and the workflow rules gate "done" on checks passing, so every card's
"Done means" clause is unsatisfiable as written while lint is red. That trains
everyone to ignore the command, which is exactly how the next real lint error
gets missed. `no-explicit-any` in particular is the rule that would have caught
the weak-typing the project standards forbid.

## Open questions

- **For the maintainer:** is `any` in test files intentional (mock ergonomics) or
  accidental? If intentional, the fix is an eslint override scoped to
  `**/tests/**` rather than 44 type annotations. That choice changes the size of
  this card by an order of magnitude, and it is a project-style call, not
  something the repo answers on its own.
- The `error-handler.ts` unused variable is likely Express's four-argument error
  middleware signature, where the unused `next` is required for Express to treat
  the handler as an error handler. If so the fix is a targeted disable comment
  explaining why, not deleting the parameter — deleting it would silently break
  error handling. Needs confirmation against the file before acting.

## Not yet refined

No `## Technical Refinement`, `## Implementation Plan`, or `## How to Test` yet —
those get written via the `refine-task` skill once the questions above are
answered. Do not move this card to In Progress before then.
