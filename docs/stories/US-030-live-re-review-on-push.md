# US-030 — Live Re-Review on Push

**As a** developer pushing fixes to a PR under active review,
**I want** the running reviewer to re-analyze the updated code in place
**so that** the posted review always reflects my latest push without Pod churn.

## Acceptance Criteria

### AC-1 — synchronize on a live job re-runs the pipeline in the same Pod
**Given** a review job whose Pod is alive (status not terminal)
**When** a `pull_request` `synchronize` delivery arrives for that PR
**Then** a `re_review` message reaches the Pod and `runPipeline` runs again — the fresh clone picks up the new head — with no new Pod created.

### AC-2 — Dead Pod falls back to a new Pod
**Given** a `synchronize` delivery whose job has no live subscriber (Pod exited)
**When** the dispatcher publishes `re_review` and sees zero subscribers
**Then** it creates a new Pod for the job instead (same flow as `opened`).

### AC-3 — Re-review posts a fresh review
**Given** a completed `re_review` run
**When** the pipeline finishes
**Then** a new PR review is posted for the updated diff and the job status returns to `reviewing`.
