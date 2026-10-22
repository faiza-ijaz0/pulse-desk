import { ApiError, ApiUnavailableError, GATEWAY_STATUSES } from './api-client';

export type RetryPolicy = {
  /** Retries after the first attempt; 0 disables retrying. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Source of jitter in [0, 1). Injectable so tests are deterministic. */
  random?: () => number;
};

/**
 * Sized for a free-tier API host waking from sleep (about a minute, docs/deployment.md):
 * waits of up to 1, 2, 4, 8, 15 and 15 seconds — at most ~45 s of waiting on top of the
 * requests themselves — before the UI stops and offers a manual retry.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 6,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
};

/**
 * Failures worth retrying automatically. Anything the API itself decided — 400, 401, 403,
 * 404, 409, 429 and validation errors — is an answer, not an outage, and is never retried.
 * The API's own 503 (a database outage) is retried, as is any gateway error.
 */
export function isTransientApiError(error: unknown): boolean {
  if (error instanceof ApiUnavailableError) return error.transient;
  if (error instanceof ApiError) return GATEWAY_STATUSES.has(error.status);
  return false;
}

/**
 * Exponential backoff with "equal jitter": the n-th wait (from 0) is between half and all of
 * min(maxDelay, base × 2ⁿ), so clients that failed together don't retry in lockstep.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  const random = policy.random ?? Math.random;
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/**
 * TanStack Query `retry`/`retryDelay` options for **queries**, which are GETs and safe to
 * repeat. Never apply these to mutations: repeating a sign-in, sign-up or sign-out could
 * multiply its effects and spend the caller's rate-limit budget. TanStack stops retrying
 * when a query is cancelled (its AbortSignal fires) or loses its last observer (unmount).
 */
export function transientRetryOptions(policy: RetryPolicy = DEFAULT_RETRY_POLICY) {
  return {
    retry: (failureCount: number, error: unknown) =>
      failureCount < policy.maxRetries && isTransientApiError(error),
    retryDelay: (failureCount: number) => backoffDelay(failureCount, policy),
  };
}
