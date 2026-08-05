---
id: "KIT-034"
status: "backlog"
priority: "medium"
assignee: ""
epic: "v5-github-webhook"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["webhook", "e2e", "docs"]
order: "d4"
---

# Webhook E2E + Setup Docs

## User Story

See [US-028](../../docs/stories/US-028-auto-review-on-pr-events.md) (whole-flow verification).

## Technical Refinement

### Files

**Created:**
- `scripts/webhook-e2e.sh` — signs and POSTs recorded GitHub payload fixtures (`scripts/fixtures/webhook/*.json`) against the deployed dispatcher: `pull_request opened` → wait Pod; `issue_comment @reviewer stop` → wait status `cancelled`; `synchronize` on a live job → assert re-review in the same Pod's logs (second "Processing job" line, no second Pod).

**Modified:**
- `scripts/minikube-setup.sh` — seed `WEBHOOK_SECRET` into the dispatcher Secret/env (generated if unset, echoed once for GitHub configuration).
- `packages/dispatcher` K8s manifest/compose env — `WEBHOOK_SECRET`, `TRIGGER_WORD`.
- `AGENTS.md` Local setup — webhook section: how to point a repo's webhook at the dispatcher (URL, content type `application/json`, secret, events: pull requests + issue comments), plus the simulated-delivery loop for local dev.

### Consumes

- KIT-031/032/033 complete surface; `scripts/e2e-test.sh` structure (wait/assert helpers).

### Produces

- Reproducible v5 verification; onboarding docs — the epic's close gate artifact.

### Design decisions

1. **Simulated deliveries, not a public tunnel** — minikube is not reachable by GitHub; signing real recorded payloads with the deployed secret exercises everything except GitHub's outbound HTTP, which is not our code. Real-webhook smoke (via ngrok or a public deploy) documented as optional manual step.
2. **Fixtures are trimmed real payloads** — only fields the router consumes plus realistic noise, checked into `scripts/fixtures/webhook/`.

### Risks

1. Fixture drift vs real GitHub payloads — mitigated: zod schemas are `.loose()`, fixtures based on GitHub's documented examples.

## Implementation Plan

1. - [ ] Fixtures: `pull-request-opened.json`, `pull-request-synchronize.json`, `issue-comment-stop.json`, `issue-comment-question.json`, `star.json` (ignored case).
2. - [ ] `scripts/webhook-e2e.sh` with sign helper (`openssl dgst -sha256 -hmac`).
3. - [ ] `minikube-setup.sh` secret seeding + manifests env.
4. - [ ] Run on minikube — all assertions pass (opened → Pod; stop → cancelled; synchronize → in-place re-review; star → ignored).
5. - [ ] AGENTS.md webhook setup section.
6. - [ ] Commit: `feat: webhook e2e script, secret seeding, and setup docs`
7. - [ ] `pnpm test && pnpm lint` green; docs-alignment sweep of the epic (close gate).

## How to Test

- **Automated**: `./scripts/webhook-e2e.sh` exits 0 on minikube; `pnpm test && pnpm lint` green.
- **Manual**: follow the new AGENTS.md section against a real repo + ngrok (optional) — PR opened on GitHub produces a posted review with zero manual curl.
- **Negative**: delivery signed with a wrong secret → 401 in dispatcher logs, no Pod; `star.json` → `{ ignored: true }`.
- **Done means**: `webhook-e2e.sh` green on minikube, docs let a newcomer wire a repo end-to-end, epic close gate (zero debt + docs alignment) passes.
