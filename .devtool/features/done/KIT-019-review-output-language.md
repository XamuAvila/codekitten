---
id: "KIT-019"
status: "done"
priority: "medium"
assignee: ""
epic: "v3-llm-integration"
dueDate: null
created: "2026-08-04"
modified: "2026-08-04"
completedAt: "2026-08-04"
labels: ["config", "prompt", "debt"]
order: "c9"
---

# Review Output in the Configured Language

## User Story

See [US-019](../../docs/stories/US-019-review-output-language.md).

## Technical Refinement

### Files

**Modified (reviewer):**
- `packages/reviewer/src/prompt/build-prompt.ts` — system prompt (lines 27-50) gains a `LANGUAGE:` block placed before `OUTPUT CONTRACT:`

**Modified (tests):**
- `packages/reviewer/tests/prompt/build-prompt.test.ts` — language block present, config-driven, excludes machine fields
- `packages/reviewer/tests/agent.test.ts` — follow-up answers inherit the language instruction
- `packages/reviewer/tests/pipeline.test.ts` — operational notices stay English (AC-4 negative guard)

**Not modified (deliberate):** `packages/reviewer/src/pipeline.ts:282-299` (`noIssuesComment`, `budgetQuestionComment`) and `packages/reviewer/src/index.ts:148-170` (cancellation notice) — see decision 4.

### Consumes

- `buildReviewPrompt(diff, files, config, conventionsContent?): BuiltPrompt` (`build-prompt.ts:21-26`) — signature unchanged
- `ReviewerConfig.language: z.string().min(1)` (`packages/shared/src/types/reviewer-config.ts:21`), default `"en"` (`packages/shared/src/config/defaults.ts`), parsed at `parse-config.ts`. Free-form string — **not** an enum.
- `PipelineResult.prompt` (`pipeline.ts:240`) → `index.ts:139-144` → `AgentConfig.reviewContext.prompt` (`agent.ts:24-27`) → `adapter.respond(prompt.system, ...)` (`agent.ts:144-148`). This chain is why AC-5 needs no agent code change.

### Produces

- System prompt contains a `LANGUAGE:` block instructing that all human-readable prose it authors — finding descriptions, suggestions, and free-text answers — be written in `config.language`, while `severity` values, `file` paths, `line` numbers and `ruleId` stay exactly as they are.
- No signature changes anywhere. This card is prompt text plus tests.

### Design decisions

1. **Language instruction goes in the system block, not the user content.** It constrains output, not input. It must also be chunk-invariant: `pipeline.ts:119` reuses `prompt.system` verbatim for every chunk, so putting it there guarantees all chunks answer in the same language. In the user content it would be rewritten per chunk by the `.replace()` at `pipeline.ts:120`.
2. **Worded to cover free text as well as findings.** The same system prompt is reused for follow-up answers (`agent.ts:145`), where the model returns prose rather than a tool call. Wording is "all prose you write", not "all findings". Note the pre-existing tension: `build-prompt.ts:47-49` tells the model to respond ONLY with structured output, and KIT-017 reuses that system prompt for free-text answers anyway, relying on the user content at `agent.ts:141` to override. This card does not fix that tension; it only avoids making it worse by not tying the language rule to the structured-output path.
3. **Emit the block unconditionally, including for `"en"`.** A conditional block would produce two prompt shapes to test and two behaviours to reason about for no gain. Rejected alternative: skip when `language === "en"` — saves one line of prompt, doubles the test matrix.
4. **Kitten's own operational notices stay English** (US-019 AC-4, decided in the story). `language` is free-form, so a static catalog cannot cover arbitrary values without silently falling back to English mid-review; routing three short notices through an extra LLM call is not worth the latency or cost. Only LLM-authored prose follows the language.
5. **Machine-readable fields are named explicitly in the instruction.** Without it a model asked to "write in Portuguese" may translate `severity: "high"` to `"alto"`, which fails `FindingSchema` validation (`packages/shared/src/types/review-job.ts:24`) and costs a retry. Cheaper to prevent in the prompt than to repair after.

### Risks

1. **Free-form language values.** `language: japanese`, `language: pt-BR` and `language: Português` are all valid config. No unit test can prove the model honours an arbitrary tag; the deterministic assertions target the prompt text, and real-model behaviour is proven once against `pt` in How to Test.
2. **Enum translation breaking schema validation.** Mitigated by decision 5, but only observable against a real model. The manual check in How to Test explicitly inspects that `severity` came back canonical.
3. **Existing prompt tests are regex/`toContain`-based** (`build-prompt.test.ts:16-67`) with no whole-string snapshot, so adding a block cannot break them — verified by reading the file. Step 1 re-runs the full prompt suite to confirm.

## Implementation Plan

1. - [ ] **RED — language block present and config-driven**: in `tests/prompt/build-prompt.test.ts`, build with `{ ...DEFAULT_CONFIG, language: "pt" }`. Assert `system` matches `/LANGUAGE:/` and contains `"pt"`. Run `npx vitest run packages/reviewer/tests/prompt/build-prompt.test.ts` → FAIL, and confirm the 8 pre-existing prompt tests are still green.
2. - [ ] **RED — default language still appears**: same file, `DEFAULT_CONFIG` (language `"en"`). Assert `system` matches `/LANGUAGE:/` and contains `"en"`. Run → FAIL.
3. - [ ] **RED — machine fields excluded**: same file, assert the system prompt matches `/severity/i` within the language block region and states those values are not translated. Run → FAIL.
4. - [ ] **GREEN — add the LANGUAGE block**: insert it in `build-prompt.ts` before the `OUTPUT CONTRACT:` section, interpolating `config.language` and naming `severity`, `file`, `line` and `ruleId` as untranslated. Run → all 11 PASS.
5. - [ ] Commit: `feat(reviewer): write review findings in the configured language`
6. - [ ] **RED — follow-ups inherit the language**: in `tests/agent.test.ts`, start the agent with a `reviewContext.prompt.system` containing `LANGUAGE: pt`, send a non-command follow-up, and assert `adapter.respond` was called with a first argument matching `/LANGUAGE: pt/`. Run `npx vitest run packages/reviewer/tests/agent.test.ts` → FAIL if the mock does not assert it yet; PASS with no source change once asserted (the chain at `agent.ts:145` already carries it).
7. - [ ] Commit: `test(reviewer): lock follow-up answers to the configured language`
8. - [ ] **RED — operational notices stay English**: in `tests/pipeline.test.ts`, run a pipeline with `language: pt` producing zero findings; assert the posted comment body contains `No issues found`. Repeat for the budget notice asserting `exceeds the token budget`. Run → FAIL if not yet covered, then PASS with no source change (guards decision 4 against future drift).
9. - [ ] Commit: `test(reviewer): keep Kitten operational notices in English regardless of language`
10. - [ ] Run `pnpm test && pnpm lint && pnpm build` — all green.

## How to Test

- **Automated**: `pnpm test`. Must be green: `tests/prompt/build-prompt.test.ts` (11 tests — the 8 existing plus language-present-for-pt, language-present-for-default, machine-fields-excluded), `tests/agent.test.ts` follow-up-language assertion, `tests/pipeline.test.ts` English-notice guards. No previously-green test may turn red.
- **Manual verification**: set `language: pt` in `XamuAvila/kitten-test-repo`'s `.reviewer.yml`, push a branch with a deliberate bug (e.g. an unawaited promise), and run a review on minikube. Expect the posted PR review to carry findings whose text and suggestions are in Portuguese. Then send a follow-up: `curl -X POST "$DISPATCHER_URL/review/<jobId>/message" -H "Content-Type: application/json" -d '{"message":"explique o primeiro finding","sender":"dev"}'` → the answer comment is in Portuguese.
- **Negative check**: on that same `language: pt` run, three things must NOT happen — (1) the `severity` column must still read `critical`/`high`/`medium`/`low`, never translated (a translated value would have failed `FindingSchema` and surfaced as `LLM_OUTPUT_INVALID` in the Pod logs); (2) the review body's `Actionable comments posted:` line stays English; (3) the budget-exceeded notice, if triggered, stays English per decision 4.
- **Done means**: `pnpm test && pnpm lint && pnpm build` all green, AND a `language: pt` review returns Portuguese finding prose with canonical English `severity` values and English Kitten notices.

## Completion notes (2026-08-04)

- `pnpm test` → 30 files, 209 tests passing (203 → 209: 3 prompt tests, 1 agent guard, 2 pipeline guards).
- `pnpm build` → exit 0. `pnpm lint` on this card's changed files → exit 0; repo-wide lint still exits 1 for the pre-existing reasons tracked in [KIT-021](KIT-021-fix-pre-existing-lint-errors.md).
- **Deviation from the plan, deliberate:** step 4 originally listed `ruleId` among the untranslatable fields. That broke KIT-018's guarantee that a repo declaring no rules never sees "ruleId" in its prompt. Fixed in the source rather than by loosening KIT-018's test: `ruleId` is governed by the conditional REPOSITORY RULES block, so naming it again in LANGUAGE was both redundant and harmful.
- Steps 6 and 8 added guards only — no production code — because the pass-through from `PipelineResult.prompt` to `adapter.respond` and the English-notice routing were both already correct. Written as regression locks, not as RED→GREEN cycles, and honest about that.
- Manual verification on minikube (`language: pt` review + Portuguese follow-up) was **not** run — needs a live cluster and LLM keys. Still outstanding, along with AC-1/AC-2/AC-5, which only a real model call can prove.
