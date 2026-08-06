---
id: "KIT-049"
status: "backlog"
priority: "medium"
assignee: ""
epic: "v8-agent-security-guardrails"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["security", "guardrails", "e2e", "docs"]
order: "f8"
---

# Security E2E + Docs + Epic Close

## User Story

See [US-036](../../docs/stories/US-036-review-inputs-respect-exclusions.md) (whole-loop verification) and US-037..039 as the e2e asserts each rejection/redaction.

## Technical Refinement

### Files

**Created:**
- `scripts/security-e2e.sh` — on minikube:
  1. **PR touching a force-added `.env`** (tracked + gitignored): Pod logs show it filtered; the monolithic prompt/summary carry no `.env` content; the Semble index/search never returns it (proves KIT-043/044/045 together).
  2. **`@reviewer remember ghp_...`** via a signed webhook: dispatcher rejects with a kind-only log; Atlas `knowledge` count unchanged (KIT-046).
  3. **Follow-up "what's in the .env?"**: posted answer contains no secrets (KIT-047).
  4. **Hostile conventions file** (prompt-injection fixture): review completes under the guardrailed contract (KIT-048).
  5. **Sidecar env assertion**: `kubectl exec` into the sidecar, `ps eww` on the Semble process → no `GITHUB_TOKEN`/LLM-key/`MONGODB_URI`/`VOYAGE_API_KEY` (KIT-045).
- `scripts/fixtures/webhook/issue-comment-remember-secret.json` — a signed `remember ghp_...` fixture for assert 2.
- A fixture repo state (or scripted commit) with a force-added `.env` and a hostile `CLAUDE.md`.

**Modified:**
- `AGENTS.md` — the invariant-1 carve-out from KIT-045, and a short "Agent security guardrails (v8)" subsection summarizing the posture.
- `docs/stories/INDEX.md` — no change (stories already indexed); verify statuses reflect reality at close.

**Decisions:**
1. E2E skips loudly (exit 0) without minikube, mirroring the deep-context e2e policy (`scripts/deep-context-e2e.sh`).
2. Epic close gate: full docs-alignment sweep — epic promises (decision table, error table, testing table) vs code, all eight cards, four stories, INDEX, AGENTS.md — per the AGENTS.md close-gate rule. Any divergence becomes a card before close.
3. Any bug/debt discovered during execution becomes a card in this epic before close (zero known debt).

### Consumes

- All eight KIT-042..048 deliverables; `scripts/webhook-e2e.sh` and `scripts/deep-context-e2e.sh` as structural templates (deliver/sign/wait helpers).

### Produces

- A repeatable security regression gate for the whole v8 posture.

## Implementation Plan

1. - [ ] `security-e2e.sh` + fixtures; runs green on minikube (or skips loudly without it).
2. - [ ] AGENTS.md section + invariant-1 carve-out (from KIT-045).
3. - [ ] Docs-alignment sweep across the epic, all cards, stories, INDEX; fix divergences in the same commit.
4. - [ ] `pnpm test && pnpm lint` green.
5. - [ ] Epic status → done; all cards done; INDEX reflects reality.

## How to Test

- **Automated**: `./scripts/security-e2e.sh` exits 0 on minikube; `pnpm test && pnpm lint` green.
- **Manual**: a real PR with a committed `.env` reviewed on minikube — no secret in prompt, logs, Atlas, or Semble results; a follow-up asking for secrets gets a masked/no answer.
- **Negative**: run without minikube → script skips loudly, exit 0; a repo with NO sensitive files reviews exactly as before (no over-blocking, confirmed by a baseline diff of the monolithic path).
- **Done means**: e2e green, docs aligned, invariant amendment recorded, epic closes with zero known debt.
