---
id: "KIT-018"
status: "in-progress"
priority: "high"
assignee: ""
epic: "v3-llm-integration"
dueDate: null
created: "2026-08-04"
modified: "2026-08-04"
completedAt: null
labels: ["config", "prompt", "debt"]
order: "c8"
---

# Custom Review Rules Applied

## User Story

See [US-018](../../docs/stories/US-018-custom-review-rules.md).

## Technical Refinement

### Files

**Modified (reviewer):**
- `packages/reviewer/src/prompt/build-prompt.ts` — user content (lines 56-67) gains a `Reviewer rules:` block; system prompt (lines 27-50) gains one line telling the model that declared rules are additional criteria and that a finding caused by one must carry its `ruleId`
- `packages/reviewer/src/chunker/consolidate.ts` — `consolidateFindings` (lines 10-31) gains an optional valid-rule-id set and strips unknown `ruleId` values
- `packages/reviewer/src/pipeline.ts` — line 147, pass the declared rule ids into `consolidateFindings`
- `packages/reviewer/src/github/review.ts` — `formatInlineComment` (lines 107-112) and the table rows (lines 76-79) render `ruleId` when present

**Modified (tests):**
- `packages/reviewer/tests/prompt/build-prompt.test.ts`
- `packages/reviewer/tests/chunker/consolidate.test.ts`
- `packages/reviewer/tests/github/review.test.ts`

### Consumes

- `buildReviewPrompt(diff, files, config, conventionsContent?): BuiltPrompt` (`build-prompt.ts:21-26`) — signature unchanged by this card
- `ReviewRule = { id: string; description: string }` (`packages/shared/src/types/reviewer-config.ts:6-11`) — no `pattern` field exists
- `ReviewerConfig.rules: readonly ReviewRule[]` (`reviewer-config.ts:36`), already parsed at `packages/shared/src/config/parse-config.ts:70`, default `[]` (`defaults.ts:22`)
- `Finding.ruleId?: string` (`packages/shared/src/types/review-job.ts:29`) — optional, already in the tool-use schema
- `consolidateFindings(results)` (`consolidate.ts:10-12`), called once at `pipeline.ts:147`
- `formatInlineComment(finding)` (`review.ts:107-112`)

### Produces

- `buildReviewPrompt` user content contains, when `config.rules.length > 0`, a block:
  ```
  Reviewer rules:
  - {id}: {description}
  ```
  emitted after the conventions block and before `Pull request diff:`. Absent entirely when `rules` is empty.
- `consolidateFindings(results, validRuleIds?: ReadonlySet<string>): readonly Finding[]` — new optional second parameter. When supplied, a finding whose `ruleId` is not in the set is kept with `ruleId` removed, and one `console.warn` line is emitted naming the unknown id (no token, key or prompt content in the log).
- Inline comment body and table rows show the rule id next to the severity when `ruleId` is present.

### Design decisions

1. **Rules live in the USER content, not the system prompt.** They are per-repo data, exactly like the conventions file. The system prompt must stay repo-invariant because `pipeline.ts:119` reuses `prompt.system` verbatim for every chunk — repo data in there would be duplicated reasoning surface with no benefit. Only the one-line instruction about *how* to treat rules goes in the system block.
2. **Rules block sits above the files block.** `pipeline.ts:120` rewrites the per-chunk user prompt with `prompt.user.replace(filesBlock(context.files), filesBlock(chunk.files))`, which matches the files block exactly. Inserting content above that anchor leaves the replacement intact; inserting *inside* it would break chunking.
3. **Unknown-`ruleId` stripping belongs in `consolidateFindings`, not in the adapter.** Consolidation runs on every path — single-call and chunked alike (`pipeline.ts:147`) — while the adapters do not share a post-processing step. One choke point, no duplication.
4. **Strip the attribution, keep the finding** (US-018 AC-5). A hallucinated `ruleId` does not make the finding itself false; discarding the whole finding would lose real signal. Least-destructive handling wins.
5. **No pattern/glob matching.** `ReviewRule` carries only `id` + `description`, and both v1 (`v1-scaffolding-dry-run.md:258`) and v2 (`v2-github-integration.md:548`) deferred pattern matching explicitly. Rules are prompt-level instructions in this card. Rejected alternative: adding a `pattern` field — that is a config-schema change serving no acceptance criterion here.

### Risks

1. **Model may ignore `ruleId` on small models.** The default is `deepseek-v4-flash` (`defaults.ts`). Automated assertions target the *prompt content* (deterministic), never model compliance. AC-3 is proven by the real-LLM check in How to Test, not by a unit test — step 7 makes that explicit rather than pretending a mock proves it.
2. **Rules text inflates the chunking estimate.** `pipeline.ts:103` compares `estimateTokens(prompt.user)` against `maxContextTokens`; a long rules list shifts that threshold. Step 4 asserts the block renders one line per rule with no file content interpolated, keeping it bounded.

## Implementation Plan

1. - [ ] **RED — rules block in prompt**: in `tests/prompt/build-prompt.test.ts`, build a prompt with two rules (`no-raw-sql`, `no-console-log`). Assert `result.user` contains `Reviewer rules:` and both `- no-raw-sql: ` and `- no-console-log: ` lines, and that the `Reviewer rules:` index is lower than the `Pull request diff:` index. Run `npx vitest run packages/reviewer/tests/prompt/build-prompt.test.ts` → FAIL.
2. - [ ] **RED — empty rules emit nothing**: same file, config with `rules: []`. Assert `result.user` does NOT contain `Reviewer rules:`. Run → FAIL (or already passing; keep as regression guard).
3. - [ ] **GREEN — render the block**: add the conditional rules block to `build-prompt.ts` user content above `Pull request diff:`, plus the one-line rule instruction in the system block. Run → both PASS.
4. - [ ] **RED — block is bounded**: assert the rules block line count equals `rules.length + 1` (header + one line per rule) and contains none of the file contents passed in. Run → FAIL, then PASS with no code change if step 3 was correct; if it fails, the renderer is interpolating too much.
5. - [ ] Commit: `feat(reviewer): pass .reviewer.yml rules into the review prompt`
6. - [ ] **RED — unknown ruleId stripped**: in `tests/chunker/consolidate.test.ts`, consolidate a result containing findings with `ruleId: "no-raw-sql"` (declared) and `ruleId: "invented-rule"` (not declared), passing `new Set(["no-raw-sql"])`. Assert the first keeps its `ruleId`, the second has `ruleId === undefined`, and both findings survive. Run → FAIL.
7. - [ ] **RED — no set means no stripping**: same file, call `consolidateFindings(results)` with no second argument. Assert every `ruleId` is preserved unchanged (back-compat for existing call sites). Run → FAIL.
8. - [ ] **GREEN — consolidate stripping**: add the optional `validRuleIds` parameter and the strip-with-warn branch. Run → PASS.
9. - [ ] **GREEN — wire pipeline**: at `pipeline.ts:147` pass `new Set(reviewerConfig.config.rules.map((r) => r.id))`. Run `npx vitest run packages/reviewer/tests/pipeline.test.ts` → PASS.
10. - [ ] Commit: `feat(reviewer): drop finding rule attribution that matches no declared rule`
11. - [ ] **RED — ruleId visible on the PR**: in `tests/github/review.test.ts`, post a review with one in-hunk finding carrying `ruleId: "no-raw-sql"` and one out-of-hunk finding carrying the same id. Assert the inline comment body contains `no-raw-sql` and the table row contains `no-raw-sql`. Run → FAIL.
12. - [ ] **GREEN — render ruleId**: update `formatInlineComment` and the table row builder. Run → PASS.
13. - [ ] Commit: `feat(reviewer): show rule attribution on findings posted to the PR`
14. - [ ] Run `pnpm test && pnpm lint && pnpm build` — all green.

## How to Test

- **Automated**: `pnpm test`. Must be green: `tests/prompt/build-prompt.test.ts` (rules block present with 2 rules, absent with 0, ordered before the diff, bounded line count), `tests/chunker/consolidate.test.ts` (declared id kept, undeclared id stripped, finding survives, no-set call unchanged), `tests/github/review.test.ts` (rule id in inline body and in table row). Total test count increases by 7; no previously-green test may turn red.
- **Manual verification**: add to `XamuAvila/kitten-test-repo`'s `.reviewer.yml`:
  ```yaml
  reviewer:
    rules:
      - id: no-console-log
        description: Production code must not call console.log — use the logger.
  ```
  and push a PR branch that adds a `console.log` to a source file. On minikube: `curl -X POST "$DISPATCHER_URL/review" -d '{"repo":"XamuAvila/kitten-test-repo","prNumber":<n>,...}'`. Expect the posted review to contain a finding on that line whose comment names `no-console-log`. Pod logs (`kubectl --context=minikube logs <jobId> -n kitten`) show the review completing without a stripped-rule warning.
- **Negative check**: run the same review against a PR in a repo whose `.reviewer.yml` declares **no** rules — the prompt must contain no `Reviewer rules:` block (assert in the unit test) and findings must carry no `ruleId`. Separately, feed `consolidateFindings` a finding with `ruleId: "made-up"` against a one-id set and confirm the finding is still returned with `ruleId` absent and exactly one warning logged containing neither the GitHub token nor any LLM key.
- **Done means**: `pnpm test && pnpm lint && pnpm build` all green, AND a rule declared in `.reviewer.yml` provably reaches `prompt.user`, AND a finding attributed to an undeclared rule loses only its attribution while remaining in the posted review.
