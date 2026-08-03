---
id: "KIT-001"
status: "done"
priority: "high"
assignee: ""
epic: "v1-scaffolding-dry-run"
dueDate: null
created: "2026-08-02"
modified: "2026-08-02"
completedAt: "2026-08-02"
labels: ["scaffolding"]
order: "a0"
---

# Project Bootstrap and Build

## User Story

See [US-001](../../docs/stories/US-001-project-bootstrap.md).

## Technical Refinement

### Files

All files are **created** (empty repo):

**Root config:**
- `pnpm-workspace.yaml` — workspace definition
- `package.json` — root workspace scripts (build, lint, test, clean)
- `tsconfig.base.json` — shared compiler options (strict, ESM, NodeNext)
- `.eslintrc.cjs` — ESLint config (typescript-eslint)
- `.prettierrc` — Prettier config
- `.gitignore` — node_modules, dist, .env, /tmp/clones
- `.env.example` — REDIS_URL, ANTHROPIC_API_KEY, GITHUB_TOKEN placeholders
- `.reviewer.yml.example` — sample reviewer config
- `vitest.workspace.ts` — vitest workspace config

**`packages/shared/`:**
- `package.json` — name: `@kitten/shared`, deps: zod, picomatch
- `tsconfig.json` — extends base, composite: true
- `src/index.ts` — barrel export
- `src/types/review-job.ts` — `ReviewJob`, `ReviewResult`, `Finding` interfaces + Zod schemas
- `src/types/reviewer-config.ts` — `ReviewerConfig`, `ReviewRule` interfaces + Zod schema
- `src/types/errors.ts` — `AppError` type with `code`, `message`, `details`
- `src/types/index.ts` — barrel
- `src/config/parse-config.ts` — `parseReviewerConfig(yamlContent: string): ReviewerConfig`
- `src/config/defaults.ts` — `DEFAULT_CONFIG: ReviewerConfig`
- `src/config/index.ts` — barrel
- `src/llm/adapter.ts` — `LLMAdapter` interface (no implementation)
- `src/llm/index.ts` — barrel
- `tests/config/parse-config.test.ts` — unit tests for config parser
- `tests/types/review-job.test.ts` — Zod schema validation tests

**`packages/dispatcher/`:**
- `package.json` — name: `@kitten/dispatcher`, deps: express, bullmq, @kitten/shared
- `tsconfig.json` — extends base, references shared
- `src/index.ts` — `console.log('[dispatcher] starting...')` (placeholder for KIT-003)

**`packages/worker/`:**
- `package.json` — name: `@kitten/worker`, deps: bullmq, simple-git, @kitten/shared
- `tsconfig.json` — extends base, references shared
- `src/index.ts` — `console.log('[worker] starting...')` (placeholder for KIT-004)

### Consumes

Nothing — first card, empty repo.

### Produces

Consumed by KIT-002, KIT-003, KIT-004:

- `@kitten/shared` package with exports:
  - `ReviewJob` — Zod schema + inferred type: `{ repo: string, prNumber: number, headRef: string, baseRef: string, sender: string, isReReview: boolean }`
  - `ReviewResult` — `{ findings: readonly Finding[], contextChecked: readonly string[], conventionsStatus: readonly string[], metadata: { model: string, inputTokens: number, outputTokens: number, durationMs: number } }`
  - `Finding` — `{ severity: 'critical' | 'high' | 'medium' | 'low', file: string, line: number, finding: string, suggestion?: string, ruleId?: string }`
  - `ReviewerConfig` — `{ language: string, model: string, maxTokens: number, trigger: string, blocking: 'comment_only' | 'request_changes', skip: readonly string[], conventionsFile: string, rules: readonly ReviewRule[] }`
  - `AppError` — `{ code: string, message: string, details?: readonly Record<string, unknown>[] }`
  - `parseReviewerConfig(yamlContent: string): ReviewerConfig` — parses YAML, validates with Zod, returns config or throws AppError
  - `DEFAULT_CONFIG: ReviewerConfig` — fallback values
  - `LLMAdapter` — interface `{ review(context: ReviewContext): Promise<ReviewResult> }`
- Buildable dispatcher/worker packages (minimal entry points) consumed by KIT-002 Dockerfiles
- Root scripts: `pnpm build`, `pnpm test`, `pnpm lint`

### Design decisions

1. **Zod for both runtime validation and type inference** — types derived from Zod schemas via `z.infer<>`, single source of truth. Rejected: separate interfaces + manual validation (drift risk).
2. **picomatch for glob matching** — lightweight, no deps, used by pnpm/vite internally. Rejected: minimatch (heavier), micromatch (more deps).
3. **ESM throughout** — `"type": "module"` in all package.json. Node 18+ target. Rejected: CJS (legacy, worse tree-shaking).
4. **vitest workspace** — one config at root, discovers tests in all packages. Rejected: per-package vitest configs (more maintenance).
5. **YAML parsing via yaml package** — `yaml` (npm) for .reviewer.yml parsing. Rejected: js-yaml (less maintained), parsing by hand.
6. **Minimal dispatcher/worker entry points** — just a console.log. Real implementation is KIT-003/KIT-004. This card only needs them to exist so `pnpm build` succeeds across workspace and KIT-002 can Dockerize.

### Risks

1. **pnpm workspace + TypeScript project references compatibility** — verified pattern, but exact tsconfig settings (composite, declarationMap, paths) may need tuning. Step 3 smoke-tests this before writing feature code.

## Implementation Plan

1. - [x] ~~`git init`~~ (skipped — not a git repo yet; parent handles git). Created root `package.json` with `"type": "module"` and workspace scripts, `pnpm-workspace.yaml` pointing to `packages/*`, `.gitignore`. `pnpm install` succeeds.
2. - [x] Created `tsconfig.base.json` with strict settings (strict, noUncheckedIndexedAccess, ESM, NodeNext). `npx tsc --showConfig` valid.
3. - [x] Created `packages/shared/` — `package.json` (`@kitten/shared`), `tsconfig.json`, empty `src/index.ts`. Deps: zod, yaml, picomatch. Shared compiles to dist/.
4. - [x] **Test (RED):** Wrote `packages/shared/tests/types/review-job.test.ts` — failed before schemas existed.
5. - [x] **Implement (GREEN):** Created `src/types/review-job.ts`, `src/types/errors.ts`, barrel exports. Test passes.
6. - [x] **Test (RED):** Wrote `packages/shared/tests/config/parse-config.test.ts` — failed before parser existed.
7. - [x] **Implement (GREEN):** Created `src/types/reviewer-config.ts`, `src/config/defaults.ts`, `src/config/parse-config.ts`. Test passes.
8. - [x] Created `src/llm/adapter.ts` with `LLMAdapter` interface and `ReviewContext` type (no implementation). Barrel export.
9. - [ ] Commit: `feat: add shared package with types, config parser, and LLM adapter interface` — SKIPPED: parent agent handles git.
10. - [x] Created `packages/dispatcher/` — `package.json` (`@kitten/dispatcher`, deps: express, bullmq, `@kitten/shared`), `tsconfig.json`, `src/index.ts` (placeholder log). All packages compile.
11. - [x] Created `packages/worker/` — `package.json` (`@kitten/worker`, deps: bullmq, simple-git, `@kitten/shared`), `tsconfig.json`, `src/index.ts` (placeholder log). All packages compile.
12. - [ ] Commit: `feat: add dispatcher and worker package skeletons` — SKIPPED: parent agent handles git.
13. - [x] Added ESLint (typescript-eslint, flat config `eslint.config.js`) + Prettier configs at root. `pnpm lint` clean.
14. - [x] Created `.gitignore`, `.env.example`, `.reviewer.yml.example`, updated `README.md` with project description and setup instructions.
15. - [ ] Commit: `chore: add linting, configs, and project docs` — SKIPPED: parent agent handles git.
16. - [x] Full check: `pnpm install && pnpm build && pnpm test && pnpm lint` — all green, 93.9% statement coverage on shared.

## How to Test

- **Automated**: `pnpm test` — expected: all tests pass. Test names:
  - `ReviewJobSchema accepts valid payload`
  - `ReviewJobSchema rejects missing repo`
  - `ReviewJobSchema rejects negative prNumber`
  - `parseReviewerConfig parses valid YAML`
  - `parseReviewerConfig returns defaults for empty input`
  - `parseReviewerConfig throws VALIDATION for invalid YAML`
  - `parseReviewerConfig preserves skip patterns`
- **Manual verification**: `pnpm build && node packages/dispatcher/dist/index.js` — prints `[dispatcher] starting...`. Same for worker.
- **Negative check**: `pnpm build` with a type error in dispatcher importing a non-existent type from `@kitten/shared` — must fail at compile time (proves cross-package type checking works).
- **Done means**: `pnpm install && pnpm build && pnpm test && pnpm lint` all succeed on a fresh clone with zero warnings.
