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
}

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
        },
      ],
    },
  };
}
