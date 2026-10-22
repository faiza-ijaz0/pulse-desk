import { healthResponseSchema } from '@pulsedesk/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/app/providers';
import { SESSION_QUERY_KEY, fetchSession } from '@/features/auth/session';
import { SIGNED_IN_SESSION, problem } from '@/test/render';
import { apiRequest } from './api-client';
import { backoffDelay, isTransientApiError, type RetryPolicy } from './retry';

type Reply = () => Response | Promise<Response>;

const networkFailure: Reply = () => Promise.reject(new TypeError('Failed to fetch'));
const gateway =
  (status: number): Reply =>
  () =>
    new Response('<html>Bad gateway</html>', { status, headers: { 'Content-Type': 'text/html' } });

/** Stubs fetch with one reply per call, in order; the last reply repeats. */
function replies(...sequence: Reply[]) {
  let call = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    const reply = sequence[Math.min(call, sequence.length - 1)]!;
    call += 1;
    return Promise.resolve().then(reply);
  });
}

async function errorFrom(reply: Reply): Promise<unknown> {
  replies(reply);
  return apiRequest('/api/v1/auth/session').then(
    () => expect.unreachable('expected the request to fail'),
    (error: unknown) => error,
  );
}

describe('isTransientApiError', () => {
  it.each<[string, Reply]>([
    ['a network failure', networkFailure],
    ['a 502 from the gateway', gateway(502)],
    ['a 503 from the gateway', gateway(503)],
    ['a 504 from the gateway', gateway(504)],
    ['the API’s own 503 (database outage)', () => problem(503, 'SERVICE_UNAVAILABLE')],
  ])('retries %s', async (_label, reply) => {
    expect(isTransientApiError(await errorFrom(reply))).toBe(true);
  });

  it('retries a host’s interstitial page served in place of the API', async () => {
    replies(() => new Response('<!doctype html><p>Starting…</p>', { status: 200 }));
    const error = await apiRequest('/health', { schema: healthResponseSchema }).catch(
      (e: unknown) => e,
    );
    expect(isTransientApiError(error)).toBe(true);
  });

  it.each<[string, Reply]>([
    ['401 unauthenticated', () => problem(401, 'UNAUTHENTICATED')],
    ['401 invalid credentials', () => problem(401, 'INVALID_CREDENTIALS')],
    ['403 forbidden (e.g. a missing proxy secret)', () => problem(403, 'FORBIDDEN')],
    ['403 CSRF rejection', () => problem(403, 'CSRF_ORIGIN_MISMATCH')],
    ['400 validation errors', () => problem(400, 'VALIDATION_FAILED')],
    ['409 conflicts', () => problem(409, 'EMAIL_TAKEN')],
    ['429 rate limiting', () => problem(429, 'RATE_LIMITED')],
    ['500 bugs', () => problem(500, 'INTERNAL_ERROR')],
    ['a non-API 404 (no API attached to this deployment)', gateway(404)],
  ])('does not retry %s', async (_label, reply) => {
    expect(isTransientApiError(await errorFrom(reply))).toBe(false);
  });

  it('does not retry a JSON response that breaks the contract', async () => {
    replies(() => Response.json({ unexpected: true }));
    const error = await apiRequest('/health', { schema: healthResponseSchema }).catch(
      (e: unknown) => e,
    );
    expect(isTransientApiError(error)).toBe(false);
  });

  it('never treats a cancelled request as an outage', () => {
    expect(isTransientApiError(new DOMException('Aborted', 'AbortError'))).toBe(false);
    expect(isTransientApiError(new Error('anything else'))).toBe(false);
  });
});

describe('backoffDelay', () => {
  const policy: RetryPolicy = { maxRetries: 6, baseDelayMs: 1_000, maxDelayMs: 15_000 };

  it('doubles up to the cap, with jitter between half and all of each step', () => {
    const low = [0, 1, 2, 3, 4, 5].map((n) => backoffDelay(n, { ...policy, random: () => 0 }));
    const high = [0, 1, 2, 3, 4, 5].map((n) =>
      backoffDelay(n, { ...policy, random: () => 0.999_999 }),
    );
    expect(low).toEqual([500, 1_000, 2_000, 4_000, 7_500, 7_500]);
    expect(high).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
  });

  it('bounds the total automatic wait to well under two minutes', () => {
    const worst = [0, 1, 2, 3, 4, 5].reduce(
      (sum, n) => sum + backoffDelay(n, { ...policy, random: () => 0.999_999 }),
      0,
    );
    expect(worst).toBe(45_000);
  });
});

describe('session restoration with the app’s QueryClient', () => {
  // random() = 0 → waits of 500 ms, 1 s, 2 s, 4 s …
  const policy: RetryPolicy = {
    maxRetries: 4,
    baseDelayMs: 1_000,
    maxDelayMs: 8_000,
    random: () => 0,
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function restore(client = createQueryClient(policy)) {
    return client.query({
      queryKey: SESSION_QUERY_KEY,
      queryFn: ({ signal }) => fetchSession(signal),
    });
  }

  it('rides out a cold start (network error, 502, 503) on an exponential schedule', async () => {
    const fetchMock = replies(networkFailure, gateway(502), gateway(503), () =>
      Response.json(SIGNED_IN_SESSION),
    );
    const restored = restore();

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await expect(restored).resolves.toMatchObject({ user: { email: 'maya@brightwave.test' } });
  });

  it('gives up after the configured number of retries', async () => {
    const fetchMock = replies(gateway(503));
    const restored = restore().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(policy.maxRetries + 1);
    expect(isTransientApiError(await restored)).toBe(true);
  });

  it.each<[string, Reply]>([
    ['403', () => problem(403, 'FORBIDDEN')],
    ['400', () => problem(400, 'VALIDATION_FAILED')],
    ['429', () => problem(429, 'RATE_LIMITED')],
  ])('fails immediately on a %s, without retrying', async (_label, reply) => {
    const fetchMock = replies(reply);
    const restored = restore().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isTransientApiError(await restored)).toBe(false);
  });

  it('treats 401 as "signed out" in a single request', async () => {
    const fetchMock = replies(() => problem(401, 'UNAUTHENTICATED'));
    const restored = restore();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(restored).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once the query is cancelled', async () => {
    const fetchMock = replies(gateway(503));
    const client = createQueryClient(policy);
    const restored = restore(client).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(600); // first attempt and first retry
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await client.cancelQueries({ queryKey: SESSION_QUERY_KEY });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await restored).toBeInstanceOf(Error);
  });

  it('shares one in-flight restoration between concurrent callers', async () => {
    const fetchMock = replies(gateway(503), () => Response.json(SIGNED_IN_SESSION));
    const client = createQueryClient(policy);
    const both = Promise.all([restore(client), restore(client)]);

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(both).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2); // one failure + one retry, not four
  });

  it('never retries mutations automatically', () => {
    expect(createQueryClient(policy).getDefaultOptions().mutations?.retry).toBe(false);
  });
});
