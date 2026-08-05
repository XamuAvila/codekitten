---
id: "KIT-031"
status: "done"
completedAt: "2026-08-05"
priority: "high"
assignee: ""
epic: "v5-github-webhook"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
labels: ["webhook", "security", "core"]
order: "d1"
---

# Webhook Route + Signature Validation

## User Story

See [US-028](../../docs/stories/US-028-auto-review-on-pr-events.md) (AC-2, AC-3, AC-4).

## Technical Refinement

### Files

**Created (dispatcher):**
- `packages/dispatcher/src/webhook/signature.ts` — `verifySignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean` using `node:crypto` `createHmac("sha256")` + `timingSafeEqual` (length-check first — timingSafeEqual throws on length mismatch). Never logs the secret or the signature.
- `packages/dispatcher/src/routes/webhook.ts` — `createWebhookRouter(deps)`: `POST /webhook/github`. Reads `X-Hub-Signature-256`, `X-GitHub-Event`, `X-GitHub-Delivery` (logged). Secret unset → 503 `SERVICE_UNAVAILABLE`. Bad signature → 401 `AUTH_FAILED`. Valid → hands `(event, payload)` to the event router (KIT-032/033; this card ships a stub that returns `{ ignored: true }` for everything).

**Modified (dispatcher):**
- `packages/dispatcher/src/server.ts` — `express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })` so the exact bytes are available for HMAC (signature covers raw body, not re-serialized JSON); mount `createWebhookRouter`. `AppConfig` gains `webhookSecret?: string`, `triggerWord: string` (default `@reviewer`).
- `packages/dispatcher/src/index.ts` — read `WEBHOOK_SECRET` / `TRIGGER_WORD` env; boot warning when `WEBHOOK_SECRET` unset.

### Consumes

- Express app wiring (`server.ts`), error handler (`middleware/error-handler.ts`), `AppError` codes (`AUTH_FAILED`, `SERVICE_UNAVAILABLE` — both already exist in `errors.ts`).

### Produces

- `verifySignature` + mounted route with raw-body access — KIT-032/033 plug the event router into it.

### Design decisions

1. **Signature check before any payload interpretation** — the handler touches `req.body` only after `verifySignature` passes (US-028 AC-2: no parse, no Redis, no K8s on bad signature). `express.json` has already parsed the body at middleware time; "no parse" means no event interpretation.
2. **`timingSafeEqual`** with explicit length guard — string comparison would leak timing.
3. **Secret absent = 503, not silent skip** — a webhook route that accepts unsigned deliveries is worse than none.
4. **Unknown event → 200 `{ ignored: true }`** — GitHub disables webhooks that keep failing; only signature failures and real dispatch errors may non-200.

### Risks

1. Body parser re-serialization mismatch — mitigated by hashing `req.rawBody` (captured buffer), never `JSON.stringify(req.body)`.

## Implementation Plan

1. - [x] RED: `packages/dispatcher/tests/webhook-signature.test.ts` — valid signature passes; wrong signature, wrong length, missing header fail; secret never in any thrown message. FAIL.
2. - [x] GREEN: `signature.ts`. PASS.
3. - [x] RED: `packages/dispatcher/tests/webhook-route.test.ts` (supertest) — signed POST with unknown event → 200 `{ ignored: true }`; bad signature → 401 `AUTH_FAILED`, no side effects; no `WEBHOOK_SECRET` → 503. FAIL.
4. - [x] GREEN: `webhook.ts` + `server.ts` raw-body wiring + env in `index.ts`. PASS.
5. - [x] Commit: `feat(dispatcher): add signature-validated GitHub webhook route`
6. - [x] `pnpm test && pnpm lint` green.

## How to Test

- **Automated**: `pnpm test` — the two new test files + dispatcher suite green.
- **Manual**: local `docker compose up`; `curl -X POST localhost:3001/webhook/github -H "X-Hub-Signature-256: sha256=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | cut -d' ' -f2)" ...` → 200; tampered body → 401.
- **Negative**: request without signature header → 401; dispatcher booted without `WEBHOOK_SECRET` → 503 + boot warning.
- **Done means**: `pnpm test && pnpm lint` exit 0; only correctly signed deliveries reach event handling.
