/**
 * Retry helper for LLM calls (KIT-011).
 *
 * Simple policy per user decision: 3 attempts, backoff 1s → 2s → 4s, on
 * transient failures. Auth errors (401) are NOT retried — they cannot heal
 * by waiting. Callers signal non-retryable errors via `isRetryable`.
 */

export interface RetryOptions {
  readonly attempts?: number;
  readonly backoffMs?: readonly number[];
  /** Default: all errors are retryable (except errors marked isAuth). */
  readonly isRetryable?: (error: unknown) => boolean;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF = [1_000, 2_000, 4_000];

function isAuthError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "isAuth" in error &&
    (error as { isAuth: unknown }).isAuth === true
  );
}

export async function callWithRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const attempts = opts?.attempts ?? DEFAULT_ATTEMPTS;
  const backoff = opts?.backoffMs ?? DEFAULT_BACKOFF;
  const isRetryable = opts?.isRetryable ?? ((error: unknown) => !isAuthError(error));

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      const retryable = isRetryable(error);
      if (!retryable || attempt === attempts) {
        throw error;
      }
      const delayMs = backoff[attempt - 1] ?? backoff[backoff.length - 1];
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
