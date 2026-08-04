---
id: US-021
title: "Lint Clean: Pre-Existing Errors Fixed"
status: draft
epic: v3-llm-integration
---

# US-021: Lint Clean: Pre-Existing Errors Fixed

## Story

As a **developer**, I want `pnpm lint` to exit 0, so that the "all green" bar in every card's Done-means clause is actually satisfiable and a future real lint error can't be buried under a pile of inherited ones.

## Context

`pnpm lint` exits 1 at `master` `c374c4d` — 47 errors in three files this repo's v3 follow-up cards never touched:
- `packages/reviewer/tests/agent.test.ts` — 42 (41× `no-explicit-any`, 1× `no-unused-vars`)
- `packages/reviewer/tests/redis/pubsub.test.ts` — 4 (3× `no-explicit-any`, 1× `no-unused-vars`)
- `packages/dispatcher/src/middleware/error-handler.ts` — 1× `no-unused-vars`

Tracked as a chore. Refinement lives in the card, `KIT-021-fix-pre-existing-lint-errors.md`.

## Acceptance Criteria

### AC-1: The three files lint clean

```
Given the three files listed above
When eslint runs against them
Then it exits 0 (no errors, no warnings)
```

### AC-2: Repo-wide lint is green

```
Given no new files are introduced
When `pnpm lint` runs
Then it exits 0
```

### AC-3: Error handling is preserved

```
Given the error middleware in error-handler.ts
When the unused `next` parameter is silenced (not deleted)
Then error responses still work — Express dispatches error handlers by arity
And the route/error tests still pass
```

## Notes

- **No eslint config change.** Fixing the `any`s, not hiding them behind a test-file override.
- **`next` is not deleted** from the Express error middleware — deleting it would silently break error handling (Express requires the 4-arg signature).
- KIT-021 (c12) lands before KIT-022 (c13) so the dead-code cleanup works on a lint-clean file.
