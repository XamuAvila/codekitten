---
id: "KIT-043"
status: "backlog"
priority: "high"
assignee: ""
epic: "v8-agent-security-guardrails"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["security", "guardrails", "reviewer"]
order: "f2"
---

# Monolithic Pipeline Exclusions: PR Files, Content, Diff, Knowledge Anchor

## User Story

See [US-036](../../docs/stories/US-036-review-inputs-respect-exclusions.md) (AC-1, AC-2).

## Technical Refinement

### Files

**Modified (reviewer):**
- `packages/reviewer/src/pipeline.ts`:
  - Move the config read (step 4, `readConfigFromRepo` at line 71) **before** diff generation, so the exclusion matcher exists before the diff is produced.
  - After config read: `const matcher = await buildExclusionMatcher(cloneDir, reviewerConfig.config)` (imported from `@kitten/shared`).
  - `fetchPrFiles` (line 67) keeps the GitHub fetch; then **re-filter in-memory** with `matcher.isExcludedPath` before `readChangedFiles` — fixes the dormant `PipelineConfig.skipPatterns = []` bug (`packages/reviewer/src/index.ts:53`). The `skipped` count in the summary comment uses the filtered set.
  - `readChangedFiles(cloneDir, prFiles, { isExcluded: matcher.isExcludedPath })` — excluded paths skipped before any read.
  - `generateDiff(cloneDir, baseRef, headRef, { exclude: matcher })` — excluded paths removed from the diff; `diffSummary` counts reflect the filtered set (US-036 AC-1: counts stay consistent).
  - `fetchKnowledge(..., diff.raw, ...)` (line 101) — the anchor uses the **filtered** diff, so excluded content cannot drive retrieval.
- `packages/reviewer/src/index.ts:45-54` — remove the `skipPatterns: []` field from `PipelineConfig` construction (now dead).
- `packages/reviewer/src/types.ts:37-46` — remove `skipPatterns` from `PipelineConfig` (or keep as optional legacy; prefer removal with all constructors updated in the same commit).
- `packages/reviewer/src/git/read-files.ts` — accept an `isExcluded` predicate; skip before `fs.readFileSync` (line 38); add a binary guard (NUL-byte / oversized) mirroring `search.ts:83-85`.
- `packages/reviewer/src/git/diff.ts` — accept the matcher; filter diff entries by path before returning `raw`/`filesChanged`/`insertions`/`deletions`.

### Consumes

- `buildExclusionMatcher`, `ExclusionMatcher` from `@kitten/shared` (KIT-042).
- Existing `generateDiff` (git/diff.ts:11-38), `fetchPrFiles` (git/files.ts:12-68), `readChangedFiles` (git/read-files.ts:17-43).

### Produces

- `PipelineResult.diff` and the LLM prompt are exclusion-filtered; `PipelineResult` metadata unchanged in shape.
- The filtered `files` array and `diff.raw` flow to `buildReviewPrompt` (monolithic) and `buildAgenticPrompt` (agentic) unchanged in signature — no prompt-builder change needed here (KIT-048 touches the system prompt).

### Design decisions

1. **Filter at the source, not the prompt.** The PR file list → content reads → diff → knowledge anchor are all filtered before anything enters a prompt or an LLM call. Defense by construction (epic D2): the model never sees the excluded content at all.
2. **Git-ignore authority is the shared matcher** — not a local reimplementation. `generateDiff` filters the changed-file paths (from `diffSummary.files`) against `matcher.isExcludedPath` and rebuilds the diff text from the kept files; binary/skip/excluded files vanish from both `raw` and the summary counts.
3. **In-memory re-filter after fetch, not in `fetchPrFiles`** — the config (and therefore `sensitive_paths`) is only known after the clone; filtering inside `fetchPrFiles` would require threading the matcher through the GitHub-fetch call. Keeping the fetch unmodified and filtering right after keeps one decision point (`pipeline.ts`) instead of two.
4. **`skipPatterns: []` removal** — `index.ts:53` hardcodes an empty list, so the existing `fetchPrFiles` picomatch filter (git/files.ts:66-67) never filters in production. Removing the dead field forces the pipeline to own filtering after config read.

### Risks

1. **Diff rebuild fidelity** — re-assembling `git diff` text from per-file hunks can drift from `git diff` output (rename detection, binary markers). Mitigation: `generateDiff` runs `git diff --name-status` + `git diff` for the kept paths, reusing git's own formatting rather than manual reconstruction. Verified by the diff test comparing against a fixture repo.
2. **Only-excluded PR** — a PR touching only excluded files yields an empty diff and zero `ReviewFile`s. Decision: proceed to the LLM with the empty context (mirrors today's no-content behavior); the summary's `skipped` count explains it; `fetchPrFiles` still returns the GitHub list so counts are honest. (US-036 AC-1 explicitly requires "the summary still counts it as skipped".)
3. **Knowledge anchor on filtered diff** — a filtered diff changes the Voyage query embedding; that is the point (secrets must not anchor retrieval). Note it in the review log line.

## Implementation Plan

1. - [ ] RED — `pipeline.test.ts`: fixture `.reviewer.yml` with `skip: ["**/generated/**"]` + a GitHub list containing `generated/x.js` → `readChangedFiles` result excludes it, `diff.raw` excludes it, and the summary comment's `skipped` count increments. FAIL against current code.
2. - [ ] GREEN — move config read before diff; build matcher; re-filter `prFiles`; thread the matcher into `readChangedFiles`/`generateDiff`; remove `skipPatterns` from `index.ts`/`types.ts`. PASS.
3. - [ ] RED — `git/read-files.test.ts`: excluded path not read; a file with a NUL byte (binary) not read. FAIL.
4. - [ ] GREEN — `read-files.ts` isExcluded + binary guard. PASS.
5. - [ ] RED — `git/diff.test.ts`: fixture repo where one changed file is gitignored → `generateDiff` with the matcher omits it from `raw`, `filesChanged`, `insertions`, `deletions`. FAIL.
6. - [ ] GREEN — `diff.ts` name-status filtering + kept-path re-diff. PASS.
7. - [ ] Full suites: `pnpm test && pnpm lint` green; commit: `feat(reviewer): exclude ignored/sensitive files from PR inputs`

## How to Test

- **Automated**: `pnpm test` — pipeline/read-files/diff tests green; all pre-existing suites stay green.
- **Manual**: on minikube, a PR touching a force-added `.env` (tracked) → Pod logs show the file filtered; the summary comment counts it under skipped; the monolithic prompt contains no `.env` content.
- **Negative**: a PR touching ONLY excluded files → review completes with no issues and a correct skipped count; a benign changed file that matches no exclusion still appears in full (no over-blocking).
- **Done means**: `pnpm test && pnpm lint` exit 0; no excluded file's content or path reaches the monolithic prompt, the diff, or the knowledge anchor, and the summary counts stay truthful.
