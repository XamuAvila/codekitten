# Kitten — Agent Guide

## What this repo is

AI Code Review Agent (White Label Reviewer). Ephemeral worker per PR with isolated clone — reviews PRs using full repo context + diff + team conventions. White-label, vendor-agnostic, self-hosted.

Full design and locked decisions live in `.devtool/epics/` — read the **latest active epic** (`v3-llm-integration.md` as of v3) before any architecture change. Earlier epics (`v1-scaffolding-dry-run`, `v2-github-integration`) are done and kept as history. What is not in the current epic does not enter its scope (each epic's out-of-scope section lists what is excluded).

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

### Bugs-in-waiting close with the epic (zero known debt)

Any bug-in-waiting, gap, or tech debt discovered **while executing an epic**
(plan step diverging from behavior, missing guard, dead spec promise) MUST be
folded into the plan being executed — as a new card in the same epic, ordered
before the epic closes. An epic is NOT done while a known bug or debt item
discovered during it remains open:

1. **Discover → card immediately** (same rule as "new work discovered
   mid-task"), tagged with the epic and a `debt` or `bug` label.
2. **Epic close gate**: before setting an epic's status to done, sweep every
   plan promise (epic error table, budget rules, testing table, each card's
   "How to Test") against the implementation. Divergence → card → fix or
   explicit user decision to defer. Deferring is the USER's call, recorded in
   the epic body — never silent.
3. Silent deferral of a known bug past epic close = process violation, same
   severity as a board out of sync.

### Docs alignment (divergence is worse than a critical bug)

Docs (epic files, cards, stories, AGENTS.md, README) must describe the
implementation with 100% fidelity at all times. A wrong doc misleads every
future session and multiplies bugs; treat divergence as MORE severe than a
critical bug — a critical bug fails one review, a wrong doc corrupts every
plan built on it.

1. **Same-commit rule**: any change that invalidates a doc statement (file
   path, behavior, flow, default, error code) updates that doc in the same
   commit — never "later".
2. **Card fidelity**: when the implementation legitimately deviates from a
   card's refinement/plan (better design found mid-TDD), edit the card to
   record what was ACTUALLY built and why, before moving it to done. Cards
   describing files or steps that never happened are divergences.
3. **Epic close alignment pass**: closing an epic includes a docs-alignment
   sweep — epic architecture/testing/error sections, all its cards, stories
   INDEX, and AGENTS.md examples must match the shipped code. The epic is not
   done until this pass is clean.
4. Found a divergence you cannot fix now? Card it immediately (`docs` label)
   and surface it to the user — never leave it undocumented.

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

# --- Option A: dispatcher + Redis only (no K8s) ---
# Fast loop for routes/validation/health. Reviews are NOT runnable here:
# POST /review returns 503 because there is no Kubernetes API to create Pods.
docker compose up -d --build
curl http://localhost:3001/health
# → {"status":"ok","redis":"connected"}
docker compose down

# --- Option B: full stack on minikube (required to actually run a review) ---
# Prerequisite: minikube >= 1.30. Seeds the GitHub token and LLM keys Secrets
# from the exported env vars. Without LLM keys the review fails at the LLM step.
GITHUB_TOKEN=<token> ANTHROPIC_API_KEY=<key> DEEPSEEK_API_KEY=<key> \
  ./scripts/minikube-setup.sh

DISPATCHER_URL=$(minikube service kitten-dispatcher -n kitten --url)

# Submit a review — creates a reviewer Pod (real LLM review since v3)
curl -X POST "$DISPATCHER_URL/review" \
  -H "Content-Type: application/json" \
  -d '{"repo":"XamuAvila/kitten-test-repo","prNumber":2,"headRef":"test/add-feature","baseRef":"master","sender":"test"}'
# → {"jobId":"review-xamuavila-kitten-test-repo-2","status":"queued"}

# Watch the reviewer Pod
kubectl --context=minikube logs review-xamuavila-kitten-test-repo-2 -n kitten
# → [reviewer] Clone complete / Diff: N files changed / Calling LLM ... / Posted findings

# Poll status: queued → running → reviewing → completed (or cancelled via stop)
curl "$DISPATCHER_URL/status/review-xamuavila-kitten-test-repo-2"

# Send a follow-up / command to the live Pod (resets its idle timer)
# Commands: "force" (full review without budget), "stop" (cancel, status cancelled)
curl -X POST "$DISPATCHER_URL/review/review-xamuavila-kitten-test-repo-2/message" \
  -H "Content-Type: application/json" \
  -d '{"message":"explain the changes","sender":"dev"}'

# Full lifecycle check (submit → LLM review → inline comments → follow-up → idle)
IDLE_TIMEOUT=30 ./scripts/e2e-test.sh

# Remove finished reviewer Pods
./scripts/cleanup-pods.sh
```

**Always pass `--context=minikube` to `kubectl`.** The scripts do this internally;
do it by hand too. A developer kubeconfig may point at a production cluster, and
these commands create namespaces, RBAC and Secrets.
