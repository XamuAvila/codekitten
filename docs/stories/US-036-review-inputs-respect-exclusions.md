# US-036 — Review Inputs Respect Repo Exclusions

**As a** repository owner using the reviewer,
**I want** the review to never read, diff, or index files that are gitignored or marked sensitive
**so that** secrets committed to my repo (even force-added files) can never enter the prompt, logs, or persistent indexes.

## Acceptance Criteria

### AC-1 — Gitignored files are excluded everywhere
**Given** a repo whose `.gitignore` ignores `config.local.yaml` and a PR that modifies it
**When** a review runs (monolithic or agentic)
**Then** the file is absent from the PR file list, the diff, the changed-file index, the read full-contents, and the knowledge anchor; the summary still counts it as skipped.

### AC-2 — Tracked-but-ignored and sensitive files are excluded
**Given** a repo with a force-added `.env` (tracked despite `.gitignore`) and a `.pem` file
**When** a review runs
**Then** neither file's content or path reaches the prompt, agentic tool results, Semble index results, or logs — even though `git check-ignore` alone would miss them.

### AC-3 — Agentic tools honor the same exclusions
**Given** an agentic review in a repo with ignored/sensitive files
**When** the model calls `read_file`, `search`, `find_related`, or `semantic_search` on such a path
**Then** the tool returns an exclusion error (or an empty result) and the path never appears in a tool result.

### AC-4 — Exclusion failures never break a review
**Given** `git check-ignore` unavailable or failing inside the clone
**When** a review starts
**Then** the matcher degrades to skip patterns + the sensitive denylist, a warning is logged, and the review completes.

## Test reminders

- nested `.gitignore` (subdirectory rules) respected
- force-added `.env` (tracked + ignored) excluded via denylist/`--no-index`
- `.reviewer.yml` `sensitive_paths` additive to the built-in denylist
- monolithic + agentic paths both filtered; skipped count preserved in the summary
- diff counts stay consistent after pathspec exclusion
