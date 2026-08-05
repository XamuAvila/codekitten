import type { V1Pod } from "@kubernetes/client-node";
import type { ReviewJob } from "@kitten/shared";

/**
 * PodConfig — configuration for the reviewer Pod template.
 * Values come from environment variables at dispatcher startup.
 */
export interface PodConfig {
  readonly namespace: string;
  readonly image: string;
  readonly idleTimeoutMs: number;
  readonly redisUrl: string;
  /** Semble sidecar image (KIT-036) — unset disables the sidecar entirely. */
  readonly sembleImage?: string;
  /** PVC name for the persistent Semble index — unset falls back to emptyDir. */
  readonly sembleIndexPvc?: string;
}

/** Fixed clone path shared with the sidecar — the Semble index key hashes
 *  this absolute path, so it must be identical across runs (KIT-036). */
const WORKSPACE_CLONE_DIR = "/workspace/repo";
const SEMBLE_SIDECAR_PORT = 8765;

/**
 * Builds a deterministic Pod name from repo + PR number.
 * K8s requires lowercase RFC 1123 labels, so we lowercase the entire name.
 * Format: review-{owner}-{repo}-{prNumber}
 */
export function buildPodName(repo: string, prNumber: number): string {
  return `review-${repo.replace("/", "-").toLowerCase()}-${prNumber}`;
}

/**
 * Builds a V1Pod manifest for a review job.
 *
 * The Pod runs a single container (the reviewer image) with job metadata
 * injected as environment variables. GITHUB_TOKEN is referenced from a
 * K8s Secret (kitten-github-token) — never passed as plain text.
 *
 * restartPolicy is Never — ephemeral Pods, one run per review.
 */
export function buildPodManifest(request: ReviewJob, config: PodConfig): V1Pod {
  const podName = buildPodName(request.repo, request.prNumber);
  const withSidecar = config.sembleImage !== undefined;
  // Index keyed by repo + base branch on the PVC — reused across runs of any
  // PR against the same base (epic D2).
  const indexPath = `/semble-index/${request.repo.replace("/", "-").toLowerCase()}/${request.baseRef}`;

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName,
      namespace: config.namespace,
      labels: {
        app: "kitten-reviewer",
        "review-job-id": podName,
      },
    },
    spec: {
      restartPolicy: "Never",
      containers: [
        {
          name: "reviewer",
          image: config.image,
          imagePullPolicy: "IfNotPresent",
          env: [
            { name: "REVIEW_JOB_ID", value: podName },
            { name: "REVIEW_REPO", value: request.repo },
            { name: "REVIEW_PR_NUMBER", value: String(request.prNumber) },
            { name: "REVIEW_HEAD_REF", value: request.headRef },
            { name: "REVIEW_BASE_REF", value: request.baseRef },
            { name: "REVIEW_SENDER", value: request.sender },
            { name: "REDIS_URL", value: config.redisUrl },
            ...(withSidecar
              ? [
                  { name: "CLONE_DIR", value: WORKSPACE_CLONE_DIR },
                  { name: "SEMBLE_SIDECAR_URL", value: `http://127.0.0.1:${SEMBLE_SIDECAR_PORT}` },
                ]
              : []),
            { name: "POD_IDLE_TIMEOUT_MS", value: String(config.idleTimeoutMs) },
            {
              name: "GITHUB_TOKEN",
              valueFrom: {
                secretKeyRef: {
                  name: "kitten-github-token",
                  key: "token",
                },
              },
            },
            // LLM provider keys — one Secret, three keys; the Pod resolves
            // which to use by base_url at runtime (KIT-012).
            {
              name: "ANTHROPIC_API_KEY",
              valueFrom: {
                secretKeyRef: {
                  name: "kitten-llm-keys",
                  key: "ANTHROPIC_API_KEY",
                },
              },
            },
            {
              name: "OPENAI_API_KEY",
              valueFrom: {
                secretKeyRef: {
                  name: "kitten-llm-keys",
                  key: "OPENAI_API_KEY",
                },
              },
            },
            {
              name: "DEEPSEEK_API_KEY",
              valueFrom: {
                secretKeyRef: {
                  name: "kitten-llm-keys",
                  key: "DEEPSEEK_API_KEY",
                },
              },
            },
          ],
          resources: {
            requests: {
              cpu: "250m",
              memory: "512Mi",
            },
            limits: {
              cpu: "1",
              memory: "1Gi",
            },
          },
          ...(withSidecar
            ? { volumeMounts: [{ name: "workspace", mountPath: "/workspace" }] }
            : {}),
        },
        ...(withSidecar
          ? [
              {
                name: "semble",
                image: config.sembleImage!,
                imagePullPolicy: "IfNotPresent",
                env: [
                  { name: "REPO_PATH", value: WORKSPACE_CLONE_DIR },
                  { name: "SEMBLE_CACHE_LOCATION", value: indexPath },
                  { name: "PORT", value: String(SEMBLE_SIDECAR_PORT) },
                ],
                volumeMounts: [
                  { name: "workspace", mountPath: "/workspace" },
                  { name: "semble-index", mountPath: "/semble-index" },
                ],
                resources: {
                  requests: { cpu: "100m", memory: "256Mi" },
                  limits: { cpu: "500m", memory: "1Gi" },
                },
              },
            ]
          : []),
      ],
      ...(withSidecar
        ? {
            volumes: [
              { name: "workspace", emptyDir: {} },
              config.sembleIndexPvc !== undefined
                ? {
                    name: "semble-index",
                    persistentVolumeClaim: { claimName: config.sembleIndexPvc },
                  }
                : // PVC absent → fresh index per run, no persistence (epic error table)
                  { name: "semble-index", emptyDir: {} },
            ],
          }
        : {}),
    },
  };
}
