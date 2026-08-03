import { Queue, type JobsOptions } from "bullmq";
import type { ReviewJob } from "@kitten/shared";

export interface ReviewQueueOptions {
  readonly queueName?: string;
}

/**
 * Builds a deterministic job ID from repo + PR number.
 * Format: review-{owner}-{repo}-{prNumber}
 */
export function buildJobId(repo: string, prNumber: number): string {
  return `review-${repo.replace("/", "-")}-${prNumber}`;
}

/**
 * Thin wrapper around BullMQ Queue for enqueuing review jobs
 * and querying job status. Only the producer side — workers are KIT-004.
 */
export class ReviewQueue {
  private readonly queue: Queue<ReviewJob>;

  constructor(
    redisUrl: string,
    options?: ReviewQueueOptions,
  ) {
    this.queue = new Queue<ReviewJob>(options?.queueName ?? "reviews", {
      connection: { url: redisUrl },
    });
  }

  async connect(): Promise<void> {
    // BullMQ connects lazily; wait for the client to be ready.
    await this.queue.waitUntilReady();
  }

  async enqueue(job: ReviewJob): Promise<string> {
    const jobId = buildJobId(job.repo, job.prNumber);

    const opts: JobsOptions = {
      jobId,
      removeOnComplete: { age: 3600 }, // keep for 1h for status queries
      removeOnFail: { age: 3600 },
    };

    await this.queue.add("review", job, opts);
    return jobId;
  }

  async getStatus(jobId: string): Promise<{ status: string }> {
    const job = await this.queue.getJob(jobId);

    if (!job) {
      return { status: "not_found" };
    }

    const state = await job.getState();
    return { status: state };
  }

  async cleanAll(): Promise<void> {
    // Drain the queue for test cleanup.
    await this.queue.drain();
    await this.queue.obliterate({ force: true });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
