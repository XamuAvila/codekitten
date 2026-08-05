---
id: "KIT-052"
status: "done"
priority: "high"
assignee: ""
epic: "v10-shared-cluster-deploy"
dueDate: null
created: "2026-08-05"
modified: "2026-08-05"
completedAt: "2026-08-05"
labels: ["dispatcher", "k8s", "config"]
order: "a0"
---

# Reviewer Pod Scheduling Config

## User Story

See [US-041](../../../docs/stories/US-041-reviewer-pods-land-on-intended-nodes.md).

## Technical Refinement

### Files

**Created (dispatcher):**
- `packages/dispatcher/src/k8s/scheduling.ts` — `TolerationSchema`,
  `PodSchedulingSchema`, `PodScheduling` type, `parsePodScheduling(json)`.
- `packages/dispatcher/tests/k8s/scheduling.test.ts` — parser tests.

**Modified (dispatcher):**
- `packages/dispatcher/src/k8s/manifest.ts`:
  - `PodConfig` (lines 8-17) gains `readonly scheduling?: PodScheduling`.
  - `buildPodManifest` `spec` block (lines 60-62) gains three conditional
    spreads, placed **after** `restartPolicy` and `containers` and before the
    existing `volumes` spread, so the diff stays one contiguous hunk.
- `packages/dispatcher/src/index.ts` (lines 3-29) — read
  `REVIEWER_POD_SCHEDULING`, parse it, exit 1 on failure, pass the result into
  `podConfig`.
- `packages/dispatcher/package.json` — move `zod` from `devDependencies` to
  `dependencies` (epic D10). `pnpm-lock.yaml` updates in the same commit.
- `packages/dispatcher/tests/k8s/manifest.test.ts` — **new tests appended
  only**. The 15 existing tests must not be edited; that is the regression
  contract (epic key decisions).

### Call sites and blast radius

`buildPodManifest` has exactly **one** production call site:
`packages/dispatcher/src/webhook/dispatch.ts:28` — `buildPodManifest(job,
deps.podConfig)`. It serves both entrypoints (`POST /review` and the webhook),
which is why v9's KIT-032 extracted it.

`PodConfig` is threaded through five files without ever being destructured:

| File | Role |
|---|---|
| `packages/dispatcher/src/index.ts:21` | builds the literal from env |
| `packages/dispatcher/src/server.ts:16` | `AppConfig.podConfig` |
| `packages/dispatcher/src/routes/review.ts:13` | `ReviewRouterDeps.podConfig` |
| `packages/dispatcher/src/webhook/events.ts:15` | `EventRouterDeps.podConfig` |
| `packages/dispatcher/src/webhook/dispatch.ts:12,28` | `DispatchDeps.podConfig` → the call |

Because every intermediate hop passes the whole object through, **adding an
optional field requires no change in any of them**. The edit surface of this
card is `manifest.ts` plus `index.ts`, and nothing else. Verify this holds by
confirming `pnpm build` succeeds without touching the three router files.

### Consumes

- `AppError` from `@kitten/shared` for the `VALIDATION` failure.
- `V1Toleration` / `V1PodSpec` types from `@kubernetes/client-node`, already a
  direct dependency.

### Produces

- `PodConfig.scheduling` — consumed by nothing else today; KIT-053 documents it.
- `parsePodScheduling` — exported for tests and for `index.ts`.

### Design decisions

1. **Config object, not Strategy** (epic D1). The variation between deployments
   is data, not behavior. Do not introduce a `PodManifestStrategy` interface.
2. **Schema lives in the dispatcher, not in `@kitten/shared`** (epic D8).
   `PodConfig` already lives in `k8s/manifest.ts`; the reviewer never sees this
   type, and `shared` is for cross-package contracts.
3. **`strictObject` at every level.** An unknown key is a `VALIDATION` error,
   matching `RawReviewerSchema` and `MCPConfigSchema`. A typo such as
   `nodeSelectors` must not be silently dropped — the visible symptom would be
   Pods on the wrong nodes, discovered as an incident.
4. **Fail fast, breaking the v3–v7 degrade-with-a-warning pattern** (epic D4).
   Ignoring broken scheduling puts review Pods on production nodes, which is the
   exact outcome the setting exists to prevent. `index.ts` logs the structured
   error and calls `process.exit(1)`; the rollout stalls and the previous
   ReplicaSet keeps serving.
5. **Conditional spread, never a default value.** Absent scheduling must produce
   a byte-identical spec. Do not initialise `nodeSelector: {}`.
6. **Spread-copy the tolerations array.** `z.array(...).readonly()` infers
   `readonly Toleration[]`; `V1PodSpec.tolerations` is `Array<V1Toleration>`
   (`@kubernetes/client-node@1.4.0`, `dist/gen/models/V1PodSpec.d.ts:175`).
   Assigning one to the other does not compile — build the spec with
   `[...scheduling.tolerations]`, keeping the config immutable.
7. **`process.exit` stays in `index.ts`.** `parsePodScheduling` throws; the
   entrypoint decides to die. Keeps the parser unit-testable without spying on
   `process.exit`.

### Risks

1. **The regression contract could be violated silently.** If a conditional
   spread is written as an unconditional one, existing tests still pass while
   every Pod gains `nodeSelector: undefined`. Mitigated by asserting on the
   absence of the keys (`'nodeSelector' in spec === false`), not on their value
   being undefined — verify this in the first RED step.
2. **Moving `zod` to `dependencies` changes the dispatcher image.** It already
   resolves at runtime because the Dockerfile installs devDependencies; the move
   corrects the declaration. Verify the image still builds
   (`docker build -f packages/dispatcher/Dockerfile .`) before closing.
3. **`z.record(z.string(), z.string())` in zod 4** — confirm the two-argument
   form is correct for this version against the installed types before writing
   the implementation; a wrong arity fails at compile time, which the first RED
   step surfaces immediately.

## Implementation Plan

**Step 0 first**: risk 3 (zod 4 `z.record` arity) is settled before any feature
code, so a wrong assumption fails in seconds rather than mid-card.

1. - [x] Confirm the `z.record` two-argument form compiles in this zod version.
   Command: `node -e "const {z}=require('zod'); console.log(z.record(z.string(), z.string()).parse({a:'b'}))"`.
   Expected: prints `{ a: 'b' }`. Wrong arity throws here, not in step 3.
2. - [x] Move `zod` from `devDependencies` to `dependencies` in
   `packages/dispatcher/package.json`. Command: `pnpm install`.
   Expected: `pnpm-lock.yaml` updates, `pnpm build` still succeeds.
3. - [x] Commit: `chore(dispatcher): declare zod as a runtime dependency`
4. - [x] RED — write `packages/dispatcher/tests/k8s/scheduling.test.ts` with
   seven cases: absent → `undefined`; empty string → `undefined`; valid full
   object → typed result; malformed JSON → `AppError` with `code === "VALIDATION"`;
   unknown key `nodeSelectors` → `VALIDATION` whose `details` names the path;
   `effect: "Nope"` → `VALIDATION`; `{ operator: "Exists" }` alone → accepted.
   Command: `npx vitest run packages/dispatcher/tests/k8s/scheduling.test.ts`.
   Expected: FAIL — cannot resolve `../../src/k8s/scheduling.js`.
5. - [x] GREEN — write `packages/dispatcher/src/k8s/scheduling.ts`.
   Command: `npx vitest run packages/dispatcher/tests/k8s/scheduling.test.ts`.
   Expected: 7 passed.
6. - [x] Commit: `feat(dispatcher): parse and validate reviewer Pod scheduling`
7. - [x] RED — append two cases to
   `packages/dispatcher/tests/k8s/manifest.test.ts`. **Given** a `PodConfig`
   without `scheduling`, **when** the manifest is built, **then**
   `"nodeSelector" in pod.spec!`, `"tolerations" in pod.spec!` and
   `"serviceAccountName" in pod.spec!` are each `false` — assert on key
   *absence*, not on `undefined`, or risk 1 goes undetected. **Given** a config
   with all three, **then** each equals the input.
   Command: `npx vitest run packages/dispatcher/tests/k8s/manifest.test.ts`.
   Expected: FAIL on the second case (15 pre-existing + 1 new pass, 1 new fails).
8. - [x] GREEN — add `scheduling?: PodScheduling` to `PodConfig` and the three
   conditional spreads to the `spec`, copying tolerations with `[...]`.
   Command: `npx vitest run packages/dispatcher/tests/k8s/manifest.test.ts`.
   Expected: 17 passed, **and the 15 pre-existing tests untouched in the diff**
   (`git diff --stat` shows only additions in that file).
9. - [x] Wire `packages/dispatcher/src/index.ts`: read
   `REVIEWER_POD_SCHEDULING`, call `parsePodScheduling`, and on `AppError` log
   `{ code, message, details }` then `process.exit(1)`; pass the result into the
   `podConfig` literal at line 21.
   Command: `pnpm build`. Expected: compiles with no edit to `server.ts`,
   `routes/review.ts`, `webhook/events.ts` or `webhook/dispatch.ts`.
10. - [x] Verify the failure path by hand.
    Command: `REVIEWER_POD_SCHEDULING='{"nodeSelectors":{}}' node packages/dispatcher/dist/index.js; echo "exit=$?"`.
    Expected: a `VALIDATION` error naming `nodeSelectors`, then `exit=1`, and no
    `[dispatcher] starting on port` line.
11. - [x] Verify the absent path.
    Command: `node packages/dispatcher/dist/index.js` with the variable unset.
    Expected: starts normally, no scheduling-related log.
12. - [x] Confirm the image still builds after the dependency move.
    Command: `docker build -f packages/dispatcher/Dockerfile -t kitten-dispatcher:kit052 .`
    Expected: build succeeds.
13. - [x] `pnpm test && pnpm lint` green; commit:
    `feat(dispatcher): configurable scheduling for reviewer Pods`

## How to Test

- **Automated**: `pnpm test` — 7 new parser tests and 2 new manifest tests green,
  and `manifest.test.ts` still reports its original 15 tests passing with no
  edits to them. `pnpm lint` clean.
- **Manual verification**: start the dispatcher with
  `REVIEWER_POD_SCHEDULING='{"nodeSelector":{"workload":"kitten"},"tolerations":[{"key":"dedicated","operator":"Equal","value":"kitten","effect":"NoSchedule"}]}'`,
  submit a review on minikube, then
  `kubectl --context=minikube get pod <job-id> -n kitten -o yaml | grep -A4 nodeSelector`
  shows the constraint. With no node carrying the label, `kubectl describe pod`
  reports `FailedScheduling` — which is the correct behavior, not a bug.
- **Negative check**: `REVIEWER_POD_SCHEDULING='{"nodeSelectors":{}}'` (typo)
  must make the dispatcher exit non-zero with a `VALIDATION` error naming the
  key — it must **not** start and ignore the value. Separately, starting with
  the variable unset must produce a Pod spec with none of the three keys
  present.
- **Done means**: `pnpm test && pnpm lint` exit 0; a valid value reaches the Pod
  spec, an invalid value stops the process, and an absent value leaves the spec
  byte-identical to before this card.
