# Kitten — Agent Guide

## What this repo is

AI Code Review Agent (White Label Reviewer). Ephemeral worker per PR with isolated clone — reviews PRs using full repo context + diff + team conventions. White-label, vendor-agnostic, self-hosted.

Full design and locked decisions: `.devtool/epics/v1-scaffolding-dry-run.md` (the v1 epic). **Read the epic before any architecture change.** What is not in it does not enter v1 (out-of-scope section lists what is excluded).

## Language

**Everything in this repo is written in English**: code, comments, docs, specs, user stories, kanban cards, commit messages, tool descriptions, error messages. No exceptions.

## Invariants (violation = bug)

1. **Worker never mutates cloned repo.** Read-only access to `/tmp/clones/{jobId}/`.
2. **Clone dirs are always cleaned up** — even on error/crash. No leaked disk.
3. **Structured errors everywhere** — `{ code, message, details }`, never bare strings.
4. **No secrets in logs** — tokens, API keys, webhook secrets never logged.
5. **Job isolation** — each review job is independent; no shared state between jobs.

## Stack and code conventions

- Mandatory TDD: test first (RED), minimal implementation (GREEN), refactor. Coverage target 80%+.
- Immutability: new objects, never in-place mutation.
- Structured errors `{ code, message, details }` — codes: `NOT_FOUND`, `VALIDATION`, `DUPLICATE`.
- Commits: `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci).
- Files 200-400 lines typical, 800 max. Functions < 50 lines.

## Working process (MANDATORY for every feature)

Flow: **User Story → Kanban tasks → technical refinement + plan → TDD → done**. No implementation starts without a story and a refined task.

### Specs ARE epics — `.devtool/epics/`

- A spec lives INSIDE the kanban as an epic file: `.devtool/epics/<slug>.md`. The epic file IS the full spec; the `epic` slug in stories and cards must match its filename/frontmatter `id`.
- **There is no separate specs folder** (`docs/superpowers/specs/` must not exist). Never create a spec document anywhere else. A new epic file exists only when a new epic starts: brainstorm → epic file (= spec) → user stories → kanban cards.
- Small change that doesn't warrant an epic → no spec: story + card only, `epic` pointing to the epic it belongs to.
- **The epic IS the writing-plans output.** It contains architecture, stack, types, project structure, and scope — everything `writing-plans` would produce. Do NOT create a separate plan document. Flow: `brainstorming → epic (= spec + plan) → user stories → kanban cards → refine-task (per card) → TDD → done`.
- **The epic MUST reference its cards.** Include an `## Implementation Cards` section with a table linking each card and its story, in execution order. The epic is the entry point — someone reading it should find all implementation details without searching.

### User stories — `docs/stories/`

- `user-stories-craft` skill standard: Connextra format — `As a [role], I want [function] so that [value]` — every story satisfying INVEST (Independent, Negotiable, Valuable, Estimatable, Small, Testable).
- Acceptance criteria as `Given / When / Then`, concrete and testable.
- Never split a story by technical layer (UI/API/DB) — every story is a full slice of value.
- **1 file per story**: `docs/stories/US-NNN-<slug>.md`.
- **`docs/stories/INDEX.md` is the fixed index** — 1 line per story (id, title, status, epic). **Token economy: read ONLY the INDEX by default; open a story file only when working on it.** Every story creation/status change updates the INDEX in the same edit.

### Kanban — `.devtool/features/`

- Each card = a `.devtool/features/<id>.md` file with YAML frontmatter (`id`, `status`, `priority`, `assignee`, `epic`, `labels`, `order`, dates) + body.
- **The card body MUST contain, before any code:**
  1. `## User Story` — link to the corresponding `US-NNN`.
  2. `## Technical Refinement` — affected files/modules, design decisions, risks, dependencies.
  3. `## Implementation Plan` — ordered steps, each with an associated test (TDD).
  4. `## How to Test` — closing section, mandatory: exact automated command(s) + expected result, manual verification (how to see it working for real), at least one negative check, and a binary "Done means" line.
- A task without refinement + plan = a task not ready for implementation. Move to In Progress only after refinement.
- **Refinement follows the `refine-task` skill** (`.claude/skills/refine-task/SKILL.md`) — the mandatory standard for filling a non-epic task's description. Epics are never refined with it: an epic is defined by its spec.
- Open questions in refinements must be genuinely open — never write a question you can answer yourself from repo context.

### The Kanban IS the progress tracker (SDD)

The board + cards are the **single source of truth for project progress** — the equivalent of a spec-driven development `progress.md`. Session task lists and conversation memory are ephemeral; the kanban survives across sessions. Mandatory checkpoints:

1. **Session start on this repo**: read the kanban first to resume real state.
2. **Before writing any code for a task**: move the card to In Progress (`status: "in-progress"`, update `modified`).
3. **Task done** (tests green + verified): move to Done (`status: "done"`, set `completedAt`).
4. **New work discovered mid-task**: create a Backlog card immediately — never keep it only in your head.
5. **Blocked**: add a `blocked` label + a note in the card body explaining what unblocks it.
6. Board columns and card frontmatter `status` MUST stay in sync.

Ending a session with the board not reflecting reality = process violation.

## Local setup

```bash
# Prerequisites: Node.js >=20, pnpm >=9, Docker + Docker Compose

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Lint
pnpm lint

# Start the full stack locally
cp .env.example .env
docker compose up -d --build

# Verify the dispatcher is healthy
curl http://localhost:3001/health
# → {"status":"ok","redis":"connected"}

# Check worker logs
docker compose logs worker --tail 20
# → [worker] Connected to Redis
# → [worker] Listening for jobs on queue: reviews

# Submit a review for dry-run testing (see US-004)
curl -X POST http://localhost:3001/review \
  -H "Content-Type: application/json" \
  -d '{"repo":"octocat/Hello-World","prNumber":1,"headRef":"master","baseRef":"master","sender":"test"}'

# Stop everything
docker compose down
```
