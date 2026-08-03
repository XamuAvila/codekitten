---
name: refine-task
description: Write the technical refinement and implementation plan of a non-epic kanban task. MANDATORY step to fill a card's description before it moves to In Progress. Use when creating a new card, when picking up an unrefined card, or when the user asks to refine/detail/plan a task.
argument-hint: "<card id, card path, or task description>"
---

# Refine Task

Produce the `## Technical Refinement` + `## Implementation Plan` + `## How to Test` sections of a kanban card (`.devtool/features/<id>.md`). A task missing any of these sections is NOT ready for implementation (AGENTS.md rule). This skill is the standard for HOW to write them.

Epics are NOT refined with this skill — an epic is defined by its own file in `.devtool/epics/` (see AGENTS.md "Specs ARE epics").

## Workflow

### 1. Understand the task

Accept a card id, a card file path, or a plain task description. If the card doesn't exist yet, create it first (frontmatter per the existing cards' pattern, `status: "backlog"`).

### 2. Gather context — in this order, before writing anything

1. Read the card's linked User Story (`docs/stories/US-NNN-*.md`). No linked story → stop and create/link one first (process rule). Read ONLY `docs/stories/INDEX.md` to locate it (token rule).
2. Read the epic's spec section(s) the story references.
3. Investigate the codebase: every file the task will touch, call sites of every function it will change, existing similar implementations to reuse. Cite `file:line` in the refinement — claims about current code need evidence.
4. Check neighboring cards for produced/consumed interfaces this task depends on.

### 3. Write `## Technical Refinement`

Required blocks:

- **Files**: exact paths — `created` vs `modified` (with line ranges when modifying).
- **Consumes**: what this task uses from earlier cards/existing code — exact names and signatures.
- **Produces**: what later cards rely on — exact function names, parameter and return types. Another agent sees only their own card; this block is how interfaces stay consistent across cards.
- **Design decisions**: each non-obvious choice + why, including rejected alternatives worth recording.
- **Risks**: genuinely unknown things, each paired with the step that verifies it early (e.g. "lib X/Y compat unverified — step 2 smoke-tests before feature code").
- **Open questions** (only if any): tagged with who answers. Genuinely open ONLY — never include a question you can answer from repo context yourself.

### 4. Write `## Implementation Plan`

- Ordered checkbox steps (`- [ ]`), each one action (2–5 min): write failing test → run, see it FAIL → minimal implementation → run, see it PASS → commit. TDD is mandatory.
- Each step names its exact command (`npx vitest run tests/...`) and expected outcome.
- Behavior-adding steps state acceptance in Given/When/Then or a concrete assertion — no ambiguous words ("fast", "properly", "handle correctly").
- Every few steps end in a commit with the exact `<type>: <description>` message.

### 5. Write `## How to Test` — mandatory closing section of every card

Every task ends with this section. It answers: **how does someone else prove this task actually works?** Not "the tests pass" — the exact commands and observations.

Required content:

- **Automated**: exact command(s) to run and the expected result (counts, names of the tests that must be green).
- **Manual verification**: what a human/agent does to see the deliverable working for real — the command to launch it, the input to give, the output to expect.
- **Negative check**: at least one thing that must FAIL or be absent — an error case that must return the right structured code, a secret that must NOT appear in output, a duplicate that must be rejected.
- **Done means**: a one-line, binary statement of completion. If it can be argued about, rewrite it.

A card whose `How to Test` could be written for any task ("run the tests, verify it works") is not refined — it is a placeholder. Be specific to this deliverable.

### 6. Self-review before saving

- **Placeholder scan**: no "TBD", "TODO", "add validation", "handle edge cases", "similar to card N", generic "How to Test" — plan failures, fix them.
- **Interface consistency**: names/types in this card match what neighboring cards declare.
- **Scope**: everything serves the linked story. Extra work discovered → new Backlog card, not silent scope growth. Any scope addition to THIS card requires removing something or splitting.
- **Testability**: every step's outcome is verifiable by a command someone else could run.

Then update the card file and the board in the same edit if the status changed.

## Quality bar (mirrors the write-spec standard, at task level)

- Be opinionated about scope: tight card beats expansive vague card.
- Cover happy path, error cases, and what must NOT happen (negative assertions).
- Requirements describe behavior, not implementation widgets.
- If the task is too big for one card (> ~1 day), split it and cross-link before refining.
