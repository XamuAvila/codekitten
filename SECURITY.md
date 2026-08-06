# Security Policy

Kitten is an agent that is handed a credential, given an isolated copy of private source
code, and allowed to write to a public-facing surface (pull request comments). Its
security posture matters more than its feature set.

This document describes what Kitten protects, how, what it does **not** yet protect,
and how to report a vulnerability.

---

## Supported versions

| Version | Supported |
|---|---|
| `0.0.1` | ✅ current — the only release |

Kitten is pre-1.0. There is no long-term support branch; fixes land on `master`.

---

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Use GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**
(<https://github.com/XamuAvila/codekitten/security/advisories/new>).

Please include:

- What an attacker can do, and what they need in order to do it.
- Reproduction steps, or a proof of concept.
- The affected component (`dispatcher`, `reviewer`, `shared`, `semble-sidecar`, a
  Kubernetes manifest, a script) and file paths if you have them.
- Your assessment of impact.

**Redact real credentials** from anything you attach — logs, configs, payloads.

What to expect: an acknowledgement, an assessment and a fix plan, a coordinated
disclosure timeline agreed with you, and credit in the advisory unless you prefer
otherwise. As a single-maintainer pre-1.0 project, response times are best-effort
rather than contractual.

---

## Threat model

### What Kitten is trusted with

| Asset | Where it lives |
|---|---|
| A GitHub token with repo access | Secret `kitten-github-token`; env of dispatcher and reviewer |
| One or more LLM API keys | Secret `kitten-llm-keys`; env of the reviewer |
| A webhook HMAC secret | Secret `kitten-webhook-secret`; env of the dispatcher |
| Knowledge-store credentials | Secret `kitten-knowledge-secrets` |
| A full clone of a private repository | `emptyDir` inside the reviewer Pod |
| Team-curated knowledge | MongoDB Atlas `kitten.knowledge` |

### Who might attack it

| Actor | Capability |
|---|---|
| **Anyone on the internet** | Can send requests to the webhook endpoint, and to the operational endpoints if they are exposed. |
| **Any user who can comment on a PR** | Can send arbitrary text into the reviewer's prompt via `@reviewer <question>` and `@reviewer remember`. |
| **Any user who can open a PR** | Can put arbitrary file content, `.reviewer.yml` and `.reviewer-mcp.json` into the reviewed branch. |
| **The LLM provider** | Sees every prompt: diffs, file contents, conventions, knowledge. |
| **A compromised dependency** | Runs inside the reviewer Pod with its full environment. |

### Trust boundaries

```
internet ──HMAC──► dispatcher ──K8s API──► reviewer Pod ──HTTPS──► LLM provider
                        │                       │
                     Redis                   clone (untrusted content)
                                                │
                                          semble sidecar (subprocess)
```

Everything crossing a boundary is validated with a Zod schema before use: webhook
payloads, HTTP bodies, config files, Redis pub/sub messages, LLM tool arguments, LLM
findings, and the sidecar's responses.

---

## What is protected today

### Webhook authentication

Every delivery to `POST /webhook/github` is verified with HMAC-SHA-256 **before the
payload is interpreted in any way**:

- The signature covers the **exact raw bytes** captured by the body parser, never
  re-serialized JSON.
- An explicit length check precedes `crypto.timingSafeEqual` — which throws on a length
  mismatch, and comparing without it would leak length through the exception path.
- A missing or malformed `X-Hub-Signature-256` is rejected outright.
- **No secret configured → `503`, not "accept everything".** A webhook accepting
  unsigned deliveries is worse than no webhook.
- Neither the secret nor the received signature is ever logged.

### Credential handling

- Secrets reach containers through Kubernetes `secretKeyRef`, never as literal values
  in a manifest. `k8s/secret.yaml` contains placeholders only.
- The clone URL embeds the token, so **every clone error path replaces the token with
  `***`** before the error message is constructed.
- The LLM API key is selected from an exact-match table of known base URLs. An unknown
  `base_url` fails with `VALIDATION` rather than sending your key to an arbitrary host
  a pull request author chose.
- `.gitignore` excludes `.env`, `*.pem`, `*.key`, `.env.*` and the entire `.claude/`
  directory. That last exclusion exists because a provider key was once leaked from
  `.claude/settings.json` in this repository's first push.

### Logging discipline

Invariant 4 — *no secrets in logs* — is enforced concretely:

- Tokens, API keys and webhook secrets are never logged.
- Agentic tool **inputs** are logged truncated to 120 characters.
- Agentic tool **results are never logged at all**, because repository file contents may
  contain secrets.
- The dispatcher's error handler returns `500 INTERNAL` for unknown exceptions and logs
  the detail server-side — internals are never echoed to a caller.

### Filesystem confinement

The agentic tool layer resolves every path through one function, which rejects:

- `../` traversal escaping the clone root,
- absolute paths outside the root,
- symlinks inside the clone pointing outside it — validated by `realpath`-ing the
  nearest existing ancestor, so a path that does not exist yet is still checked.

The `search` walk never follows symlinks. `.git/` is excluded unconditionally.

**There is no write tool.** The registry contains seven executors and all of them are
readers. This is a structural property, not a configuration.

### Isolation and cleanup

- One Pod per review, `restartPolicy: Never`, no shared filesystem between jobs.
- The clone directory is removed in a `finally` block — on success, on failure, on
  thrown error.
- RBAC grants the dispatcher's ServiceAccount `create/delete/get/list/watch` on Pods
  and `get` on `pods/log`, scoped to the `kitten` namespace. Nothing else.

### Deploy pipeline (EKS)

- GitHub Actions authenticates to AWS through **OIDC federation**, not stored access
  keys. The IAM trust policy admits exactly one subject:
  `repo:<owner>/<repo>:ref:refs/heads/<deploy-branch>` — a pull request from a fork
  cannot assume it.
- The role's permissions are ECR push on the three Kitten repositories plus
  `eks:DescribeCluster`. It cannot touch anything else in the account.
- The CI's in-cluster RBAC (`kitten-ci-deploy`) is **read-only on Secrets and
  ConfigMaps**. Secrets are created solely by `scripts/eks-setup.sh`, run by a human
  holding admin kubeconfig.
- `k8s/secret.yaml` is excluded from `k8s/kustomization.yaml`, so a deploy can never
  overwrite live Secrets with the committed placeholder.
- Images are tagged with the commit SHA rather than a mutable tag.
- Bot-authored comments are ignored, so the reviewer cannot trigger itself through its
  own output.

### Untrusted input from pull requests

- File paths from the GitHub API are treated as untrusted: each resolved path is
  asserted to stay inside the clone before any read.
- Regex search from the model runs inside a `vm.Script` with a **2-second timeout**,
  because catastrophic backtracking is uninterruptible from plain JavaScript. The query
  is capped at 500 characters.
- LLM findings are validated against a Zod schema; an invalid `ruleId` is stripped.
- Malformed webhook payloads are acknowledged as ignored rather than retried.

---

## Known limitations

**These are real gaps in `0.0.1`, listed here deliberately rather than left for you to
discover.** Closing them is the entire scope of the in-progress
[v8 epic](.devtool/epics/v8-agent-security-guardrails.md).

### 1. Exclusions do not cover the ingestion path

`.reviewer.yml`'s `skip` is enforced **only in the agentic tool layer**. In the
monolithic path the changed-file list is fetched with an empty pattern array, so:

- Every changed file is read in full and sent to the model.
- The raw diff is emitted with no filtering.
- **A pull request that touches a committed `.env` puts its contents in the prompt.**

`.gitignore` is never consulted by any component. The default `skip` patterns cover
generated code (`**/Migrations/**`, `*.Designer.cs`, `**/*.snap`, `**/node_modules/**`)
and do not cover `.env`, private keys, `.npmrc`, `.netrc` or Kubernetes Secret
manifests.

*Mitigation until fixed:* do not commit secrets to repositories you point Kitten at —
which is good practice regardless — and prefer agentic mode, where exclusions are
actually enforced.

### 2. The knowledge store accepts anything

`@reviewer remember <text>` and correction replies are stored **verbatim**, with no
secret detection. A pasted token is embedded into the vector store and re-injected into
the prompt of **every future review of that repository**. Any user who can comment on a
PR can write to it, and there is no delete command.

*Mitigation until fixed:* treat write access to the knowledge store as equivalent to
comment access on the repository. Remove bad entries directly in MongoDB.

### 3. Follow-up answers are not filtered

A follow-up question is interpolated into a prompt that re-sends the entire review
context — including full file contents — and the model's answer is posted as a public
PR comment. Nothing in the system prompt forbids revealing secrets, and nothing scans
the answer before it is posted. On a public repository, a crafted question is a
plausible path to extracting content from a private dependency's file that happened to
be in context.

### 4. Repository content is presented as authoritative

`.reviewer.yml`, the conventions file and stored knowledge are injected into the prompt
as trusted instructions rather than as untrusted data. A pull request author controls
all three on their branch. **Prompt injection through a repository file is not
currently defended against.**

### 5. The sidecar receives the full Pod environment

The Semble sidecar spawns `semble[mcp]` with `env=dict(os.environ)` — every secret in
the Pod is handed to a third-party subprocess whose index persists on a **cross-job**
PersistentVolumeClaim. It indexes the whole repository, honoring only the reviewed
repo's own ignore files; Kitten's `skip` never reaches it.

*Mitigation until fixed:* run without `SEMBLE_IMAGE` if this is unacceptable in your
environment.

### 6. The operational endpoints are unauthenticated

`POST /review`, `GET /status/:jobId` and `POST /review/:jobId/message` have no
authentication whatsoever. Anyone who can reach the dispatcher can start a review of
any repository the token can access, read job status, and send commands to a live Pod.
Only `/webhook/github` authenticates its caller.

*Mitigation:* do not expose the dispatcher directly. Use a NodePort/ClusterIP reachable
only inside the cluster, or an ingress that authenticates. If you tunnel it for
webhooks, expose **only** the `/webhook/github` path.

### 7. No global cost or concurrency ceiling

Budgets are per review. Nothing limits how many reviewer Pods can exist simultaneously
or how much a repository can spend per day. A pull-request bombing attack on a
webhook-connected repository translates directly into LLM spend and node pressure.

*Mitigation:* apply a namespace `ResourceQuota`, and set provider-side spend limits.

### 8. Everything is sent to a third-party model

By design, the diff, the full contents of changed files, the conventions file and stored
knowledge are sent to the configured LLM provider. Self-hosting Kitten keeps the code
inside your network up to that call, and no further. Choose a provider — and an endpoint
— whose data-handling terms you accept.

---

## Hardening checklist for operators

- [ ] Use a **dedicated bot account** for the GitHub token, scoped to the repositories
      that need review, with `Contents: read` + `Pull requests: write`.
- [ ] Keep the dispatcher off the public internet; expose only `/webhook/github`.
- [ ] Set a strong `WEBHOOK_SECRET` and rotate it deliberately — re-running
      `minikube-setup.sh` without exporting it generates a new one and silently breaks
      the configured webhook.
- [ ] Apply a namespace `ResourceQuota` to cap concurrent reviewer Pods.
- [ ] Set spend limits with your LLM provider.
- [ ] Restrict network egress from the `kitten` namespace to GitHub, your LLM provider
      and (if used) Atlas and Voyage.
- [ ] Never apply `k8s/secret.yaml` unmodified — it contains placeholders.
- [ ] Audit the knowledge store periodically; anyone who can comment can write to it.
- [ ] Treat the Semble PVC as containing repository-derived data, and delete it when
      you stop reviewing a repository.
- [ ] Remember that `0.0.1` posts every comment with a `[KITTEN-TEST]` marker — remove
      it before real reviewers see the output.

---

## Out of scope

Kitten reviews code; it is not a security scanner. The threat model above concerns
**the agent itself**, not the code it reads. Findings it reports about vulnerabilities
in a reviewed repository are advisory model output, not a security audit, and should
never be the only control in a pipeline.
