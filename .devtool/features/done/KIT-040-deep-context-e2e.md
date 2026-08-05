---
id: "KIT-040"
status: "done"
priority: "medium"
assignee: ""
epic: "v7-deep-context"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
completedAt: "2026-08-05"
labels: ["deep-context", "e2e", "docs"]
order: "e6"
---

# Deep Context E2E + Docs + Invariant Amendment

## User Story

See [US-034](../../docs/stories/US-034-knowledge-calibrated-reviews.md) (AC-3) — whole-loop verification.

## Technical Refinement

**Created:**
- `scripts/deep-context-e2e.sh` — on minikube with real secrets: (1) simulated `remember` delivery → assert Atlas doc; (2) agentic review → assert knowledge block + a `semantic_search`/`git_log` call in Pod logs; (3) kill sidecar → review still completes; (4) second review same base → "index reused" log.
- Atlas index bootstrap step (idempotent) in `minikube-setup.sh` (or documented one-time command).

**Modified:**
- `AGENTS.md` — invariant 5 amended (cross-job state ONLY via Semble PVC + Atlas knowledge; filesystem isolation unchanged); Local setup gains `MONGODB_URI`/`VOYAGE_API_KEY` seeding + deep-context e2e command; knowledge feature docs (`remember`, corrections).
- `scripts/minikube-setup.sh` — seed the two new secrets when exported.

**Decisions:**
1. E2E needs real Atlas/Voyage — skipped (with loud message) when secrets absent, same policy as the DeepSeek integration suite.
2. Epic close gate: full docs-alignment sweep (epic promises vs code, all six cards, INDEX, AGENTS.md) per the AGENTS.md close-gate rule.

## Implementation Plan

1. - [x] `deep-context-e2e.sh` + setup seeding + Atlas index bootstrap.
2. - [x] Run on minikube with real secrets — all four assertions PASSED (2026-08-05, mongodb-atlas-local via compose + Voyage via ai.mongodb.com). Negative path also verified earlier: script skips loudly without secrets, exit 0.
3. - [x] AGENTS.md: invariant amendment + setup + feature docs.
4. - [x] Docs-alignment sweep; fix divergences in the same commit.
5. - [x] Commit: `feat: deep-context e2e, docs, and job-isolation amendment`
6. - [x] `pnpm test && pnpm lint` green; epic → done.

**Execution notes (2026-08-05):**
- E2e surfaced and closed three real defects before the epic could close: KIT-041 (clone never checked out headRef), stale minikube image builds (dispatcher/reviewer rebuilt; `minikube image build -f` bug worked around for the sidecar), and cold-start index/model download (fixed with `HF_HOME` on the PVC + a warmup search at sidecar boot).
- Local knowledge stack: compose `mongo` service (`mongodb/mongodb-atlas-local`, port 27021) + `VOYAGE_BASE_URL=https://ai.mongodb.com` for MongoDB-provisioned Voyage keys.

## How to Test

- **Automated**: `./scripts/deep-context-e2e.sh` exits 0 with secrets; `pnpm test && pnpm lint` green.
- **Manual**: `@reviewer remember` on a real PR → next review visibly respects it.
- **Negative**: run without `MONGODB_URI` → e2e skips loudly; reviews unaffected.
- **Done means**: e2e green, docs aligned, invariant amendment recorded, epic closes with zero known debt.
