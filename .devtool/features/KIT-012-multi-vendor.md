---
id: "KIT-012"
status: "backlog"
priority: "high"
assignee: ""
epic: "v3-llm-integration"
dueDate: null
created: "2026-08-03"
modified: "2026-08-03"
completedAt: null
labels: ["llm", "config"]
order: "c2"
---

# Multi-Vendor Provider Configuration

## User Story

See [US-012](../../docs/stories/US-012-multi-vendor.md).

## Technical Refinement

### Files

**Created (shared):**
- `packages/shared/src/llm/openai-adapter.ts` — `OpenAIAdapter implements LLMAdapter` (incl. `respond` — the KIT-011 interface addition)
- `packages/shared/src/llm/factory.ts` — `createLlmAdapter(config)` + `resolveLlmKeyEnv(baseUrl)`

**Modified (dispatcher):**
- `packages/dispatcher/src/k8s/manifest.ts` — Pod env (lines 54-72): add the three LLM key env vars from the new Secret via `secretKeyRef`
- `packages/dispatcher/tests/k8s/manifest.test.ts` — assert the three keys are referenced

**Modified (reviewer):**
- `packages/reviewer/src/pipeline.ts` — read config `provider`/`baseUrl` (already via `readConfigFromRepo`), build adapter via `createLlmAdapter`, pass `baseUrl` + resolved key env

**Modified (k8s):**
- `k8s/secret.yaml` — add `kitten-llm-keys` template with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY` (placeholder values, never committed)
- `scripts/minikube-setup.sh` — create the Secret from env vars when present

### Consumes

- `AnthropicAdapter` from KIT-011 — used by `createLlmAdapter` when `provider: "anthropic"`
- `LLMAdapter` interface (`packages/shared/src/llm/adapter.ts:26`) — includes `respond` (added in KIT-011)
- `ReviewerConfig.provider` / `.baseUrl` — schema fields added in KIT-011 (this card implements factory + key resolution, not the schema)
- `PipelineConfig` (`packages/reviewer/src/types.ts:37-46`)

### Produces

- `createLlmAdapter(config: ReviewerConfig): LLMAdapter` — selects `AnthropicAdapter` (provider "anthropic") or `OpenAIAdapter` (provider "openai"), passing `baseUrl` + key from `process.env`
- `resolveLlmKeyEnv(baseUrl: string): "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "DEEPSEEK_API_KEY"` — exact-match map: `https://api.anthropic.com` → ANTHROPIC, `https://api.deepseek.com/anthropic` → DEEPSEEK, `https://api.openai.com` → OPENAI; unknown → throws `AppError("VALIDATION", ...)` (US-012 AC-5)
- `OpenAIAdapter` — `response_format: { type: "json_schema", json_schema: { name: "findings", schema, strict: true } }`
- K8s: `kitten-llm-keys` Secret with 3 keys; Pod manifest references them (US-012 AC-6)

### Design decisions

1. **Key resolved by `base_url`, not `provider`** (user decision) — DeepSeek is `provider: anthropic` + DeepSeek base_url, so the key must follow the URL. Exact-match map, no substring heuristics (US-012 AC-4).
2. **`provider` only selects the SDK** — Anthropic SDK covers Anthropic + DeepSeek (`base_url` override); OpenAI SDK for OpenAI. No special "deepseek" provider value.
3. **Unknown base_url fails validation** — no key mapping, fail fast with `VALIDATION` before any LLM call. Better than guessing.
4. **One Secret, three keys** — same trust boundary as the Pod itself; dispatcher does not need to know the provider at manifest-build time (config lives in the repo clone, read by the Pod).
5. **OpenAI SDK `response_format: json_schema`** — strict mode; the JSON schema mirrors `FindingSchema`.

### Risks

1. **DeepSeek Anthropic endpoint tool-use compatibility** — verified against api-docs.deepseek.com/guides/anthropic_api (tools/tool_choice/tool_use Fully Supported; output_config only "effort"). Integration test (step 8) validates with a real call before the feature ships.
2. **OpenAI strict json_schema version drift** — SDK 7.3.0; strict schema must be `additionalProperties: false`-compatible. Unit test asserts request shape.

## Implementation Plan

1. - [ ] **RED — config schema test**: extend `packages/shared/tests/config/parse-config.test.ts`: YAML `provider: "openai"` → `provider: "openai"`; `base_url: "https://x"` → `baseUrl: "https://x"`; invalid `provider: "watson"` → `VALIDATION`. Run: FAIL. (Schema fields were added by KIT-011 — this RED is a coverage test for the provider/base_url paths, which KIT-011's step 2 may already satisfy; if green already, keep as regression coverage and mark PASS without code change.)
2. - [ ] **GREEN — schema coverage**: only if step 1 still fails (e.g. `provider`/`base_url` not yet in `RawReviewerSchema`). PASS.
3. - [ ] Commit: `test(shared): cover provider/base_url config parsing`
4. - [ ] **RED — factory + key resolution test**: create `packages/shared/tests/llm/factory.test.ts`. Assert: each known base_url maps to the correct env name; unknown base_url throws `AppError("VALIDATION")`; `createLlmAdapter` returns AnthropicAdapter for provider "anthropic" and OpenAIAdapter for "openai". Run: FAIL.
5. - [ ] **GREEN — factory.ts**: implement `resolveLlmKeyEnv` + `createLlmAdapter`. PASS.
6. - [ ] Commit: `feat(shared): add LLM adapter factory with base_url key resolution`
7. - [ ] **RED — OpenAIAdapter test**: create `packages/shared/tests/llm/openai-adapter.test.ts` (mock `openai` SDK). Assert: `response_format.json_schema` present with `FindingSchema`-shaped schema and `strict: true`; response `choices[0].message` JSON parsed into `ReviewResult.findings`; metadata populated; `respond` returns the text answer. Run: FAIL.
8. - [ ] **GREEN — openai-adapter.ts**: implement (incl. `respond`). PASS.
9. - [ ] Commit: `feat(shared): add OpenAIAdapter with json_schema structured output`
10. - [ ] **RED — pipeline wiring test (mocked)**: `packages/reviewer/tests/pipeline.test.ts` — pipeline builds the adapter via `createLlmAdapter` (mock factory or mock SDK): provider "openai" config → OpenAI SDK called, findings parsed. **RED — LLM_OUTPUT_INVALID path**: adapter returns schema-invalid output → retried once → still invalid → `failed` with `LLM_OUTPUT_INVALID`. Run: FAIL.
11. - [ ] **GREEN — pipeline wiring**: pipeline builds adapter via `createLlmAdapter` with config from repo + env key; output validation + single retry → `LLM_OUTPUT_INVALID`. PASS.
12. - [ ] Commit: `feat(reviewer): wire multi-vendor adapter into pipeline`
13. - [ ] **RED — integration test with real DeepSeek**: create `packages/reviewer/tests/llm-integration.test.ts` (skipped unless `DEEPSEEK_API_KEY` env set, `describe.skipIf`). Assert: full pipeline path via `createLlmAdapter` with a config `provider: "anthropic", base_url: "https://api.deepseek.com/anthropic", model: "deepseek-v4-flash"` returns a schema-valid `ReviewResult` for a small fixture prompt. Run with `DEEPSEEK_API_KEY=... pnpm --filter @kitten/reviewer test` — passes only after step 11 wiring.
14. - [ ] **GREEN — integration**: if the real call exposes adapter shape issues, fix them. PASS.
15. - [ ] Commit: `feat(reviewer): validate real DeepSeek calls through the factory`
16. - [ ] **RED — manifest test**: update `packages/dispatcher/tests/k8s/manifest.test.ts` first — assert Pod env includes the 3 LLM keys via `secretKeyRef` from `kitten-llm-keys`. Run: FAIL.
17. - [ ] **GREEN — manifest + Secret**: add `kitten-llm-keys` Secret template (`k8s/secret.yaml`), Pod env `secretKeyRef` for the 3 keys in `manifest.ts`, `minikube-setup.sh` Secret creation. PASS.
18. - [ ] Commit: `feat(k8s): add kitten-llm-keys secret and Pod env wiring`
19. - [ ] Run: `pnpm test && pnpm lint` — all green.

## How to Test

- **Automated**: `pnpm test` — `packages/shared/tests/llm/factory.test.ts` (key resolution + adapter selection), `packages/shared/tests/llm/openai-adapter.test.ts` (json_schema shape), `packages/shared/tests/config/parse-config.test.ts` (provider/base_url), `packages/dispatcher/tests/k8s/manifest.test.ts` (3 keys via secretKeyRef). All PASS.
- **Manual verification (real DeepSeek)**: `DEEPSEEK_API_KEY=<key> node packages/reviewer/dist/index.js` with `REVIEW_*` envs and a repo whose `.reviewer.yml` has `provider: anthropic`, `base_url: https://api.deepseek.com/anthropic`, `model: deepseek-v4-flash` → pipeline completes, PR gets a findings comment; logs show `LLM call: deepseek-v4-flash (base_url https://api.deepseek.com/anthropic)`.
- **Negative check**: `.reviewer.yml` with `base_url: https://gateway.example.com` → review fails with `{ code: "VALIDATION" }` "no key mapping for base_url", **no LLM call made** (verify in logs). Also: `provider: "watson"` → `VALIDATION`.
- **Done means**: `pnpm test` green; real DeepSeek integration test passes with `DEEPSEEK_API_KEY` set; Pod manifest references the three keys from `kitten-llm-keys`; unknown base_url fails with `VALIDATION` before any LLM call.
