import { z } from "zod";
import type { Redis } from "ioredis";
import type { PubSubMessage, ReviewJob, ReviewJobStatus } from "@kitten/shared";

import type { K8sClient } from "../k8s/client.js";
import { buildPodName } from "../k8s/manifest.js";
import type { PodConfig } from "../k8s/manifest.js";
import { dispatchReview } from "./dispatch.js";
import { publishFollowUp, TERMINAL_STATUSES } from "./follow-up.js";
import type { RouteEventResult } from "../routes/webhook.js";

export interface EventRouterDeps {
  readonly k8sClient: K8sClient;
  readonly redis: Redis;
  readonly podConfig: PodConfig;
  readonly triggerWord: string;
}

const HANDLED_PR_ACTIONS = new Set(["opened", "reopened", "synchronize"]);

// Only the consumed fields are validated; GitHub payloads are huge and
// additive, so everything else passes through loose.
const PullRequestEventSchema = z
  .object({
    action: z.string(),
    pull_request: z
      .object({
        number: z.number().int().positive(),
        state: z.string(),
        head: z.object({ ref: z.string().min(1) }).loose(),
        base: z.object({ ref: z.string().min(1) }).loose(),
      })
      .loose(),
    repository: z.object({ full_name: z.string().min(1) }).loose(),
    sender: z.object({ login: z.string().min(1), type: z.string().optional() }).loose(),
  })
  .loose();

/**
 * Routes a signature-validated webhook event (v5). Unhandled events/actions
 * and malformed payloads are acknowledged as ignored — GitHub must never be
 * left retrying a delivery we will never consume.
 */
export async function routeEvent(
  event: string,
  payload: unknown,
  deps: EventRouterDeps,
): Promise<RouteEventResult> {
  if (event === "pull_request") {
    return handlePullRequest(payload, deps);
  }
  if (event === "issue_comment") {
    return handleIssueComment(payload, deps);
  }
  return { ignored: true };
}

const IssueCommentEventSchema = z
  .object({
    action: z.string(),
    issue: z
      .object({
        number: z.number().int().positive(),
        // Present only when the issue IS a pull request
        pull_request: z.object({}).loose().optional(),
      })
      .loose(),
    comment: z
      .object({
        body: z.string(),
        user: z.object({ login: z.string().min(1), type: z.string().optional() }).loose(),
      })
      .loose(),
    repository: z.object({ full_name: z.string().min(1) }).loose(),
  })
  .loose();

async function handleIssueComment(payload: unknown, deps: EventRouterDeps): Promise<RouteEventResult> {
  const parsed = IssueCommentEventSchema.safeParse(payload);
  if (!parsed.success) {
    console.warn(`[dispatcher] Malformed issue_comment payload ignored: ${parsed.error.issues[0]?.path.join(".")}`);
    return { ignored: true };
  }

  const data = parsed.data;
  if (data.action !== "created") return { ignored: true };
  if (!data.issue.pull_request) return { ignored: true }; // plain issue, not a PR
  // Bot filter is mandatory: the reviewer posts comments itself — without
  // this, a trigger word inside a reviewer comment would self-trigger.
  if (data.comment.user.type === "Bot") return { ignored: true };

  // Trigger match is prefix-only, case-insensitive (KIT-033 decision 3)
  const body = data.comment.body.trim();
  if (!body.toLowerCase().startsWith(deps.triggerWord.toLowerCase())) {
    return { ignored: true };
  }
  const text = body.slice(deps.triggerWord.length).trim();
  const command = text.toLowerCase();
  const message = command === "force" || command === "stop" ? command : text;
  if (message === "") return { ignored: true };

  const jobId = buildPodName(data.repository.full_name, data.issue.number);
  const sent = await publishFollowUp(deps.redis, jobId, message, data.comment.user.login);
  if (!sent) {
    console.log(`[dispatcher] Comment command for inactive job ${jobId} ignored`);
    return { ignored: true };
  }
  return { jobId, status: "sent" };
}

async function handlePullRequest(payload: unknown, deps: EventRouterDeps): Promise<RouteEventResult> {
  const parsed = PullRequestEventSchema.safeParse(payload);
  if (!parsed.success) {
    console.warn(`[dispatcher] Malformed pull_request payload ignored: ${parsed.error.issues[0]?.path.join(".")}`);
    return { ignored: true };
  }

  const data = parsed.data;
  if (!HANDLED_PR_ACTIONS.has(data.action) || data.pull_request.state !== "open") {
    return { ignored: true };
  }

  const job: ReviewJob = {
    repo: data.repository.full_name,
    prNumber: data.pull_request.number,
    headRef: data.pull_request.head.ref,
    baseRef: data.pull_request.base.ref,
    sender: data.sender.login,
    isReReview: false,
  };
  const jobId = buildPodName(job.repo, job.prNumber);

  // Active job → re-review in place: the live Pod re-runs the pipeline and
  // its fresh clone picks up the new head (epic D3). Dead Pod (no
  // subscriber) → fall through to a new Pod.
  if (await isJobActive(deps.redis, jobId)) {
    const message: PubSubMessage = {
      type: "re_review",
      payload: {},
      timestamp: new Date().toISOString(),
    };
    const subscribers = await deps.redis.publish(`review:${jobId}:messages`, JSON.stringify(message));
    if (subscribers > 0) {
      console.log(`[dispatcher] re_review published to live Pod for ${jobId}`);
      return { jobId, status: "re_review" };
    }
    console.log(`[dispatcher] ${jobId} active in Redis but Pod dead — dispatching new Pod`);
    return dispatchReview({ ...job, isReReview: true }, deps);
  }

  return dispatchReview(job, deps);
}

async function isJobActive(redis: Redis, jobId: string): Promise<boolean> {
  const raw = await redis.get(`review:${jobId}:status`);
  if (!raw) return false;
  try {
    const status = JSON.parse(raw) as ReviewJobStatus;
    return !TERMINAL_STATUSES.has(status.status);
  } catch {
    return false;
  }
}
