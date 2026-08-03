---
id: "{{CARD_ID}}"
status: "backlog"
priority: "medium"
assignee: "{{ASSIGNEE}}"
epic: "{{EPIC_SLUG}}"
dueDate: null
created: "{{CREATED_ISO}}"
modified: "{{CREATED_ISO}}"
completedAt: null
labels: []
order: "a0"
---

# {{CARD_TITLE}}

## User Story

See [US-NNN](../../docs/stories/US-NNN-slug.md).

## Technical Refinement

- **Files**: exact paths — `created` vs `modified` (with line ranges when modifying).
- **Consumes**: what this task uses from earlier cards/existing code.
- **Produces**: what later cards rely on — exact names, types.
- **Design decisions**: non-obvious choices + why, rejected alternatives.
- **Risks**: genuinely unknown things, each paired with an early verification step.

## Implementation Plan

1. [ ] Step 1 — test: `describe('...', ...)`, command: `...`, expected: FAIL
2. [ ] Step 2 — implement, command: `...`, expected: PASS
3. [ ] Commit: `feat: ...`

## How to Test

- **Automated**: exact command(s) to run + expected result (test counts, names).
- **Manual verification**: what to do to see it working for real.
- **Negative check**: at least one thing that must FAIL or be absent.
- **Done means**: one-line binary statement of completion.
