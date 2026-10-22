import { expect, type APIRequestContext } from '@playwright/test';

/**
 * Reported by `GET /health` of the API that playwright.config.ts starts (as APP_VERSION), so
 * the suite can prove the preview server forwards to *that* API — not a leftover or dev
 * server, which could be connected to a different database.
 */
export const E2E_API_VERSION = 'e2e-suite-api';

/** Fails fast, with a diagnosis, unless `/health` on the web origin reaches this run's API. */
export async function expectPreviewProxiesToE2eApi(request: APIRequestContext) {
  const res = await request.get('/health');
  const body: unknown = await res.json().catch(() => undefined);
  expect(
    { status: res.status(), body },
    'GET /health through the preview server must reach the API this run started. A 502 means ' +
      'the preview proxies to an API that is not running (e.g. a stale `vite preview` left on ' +
      'port 4173); another version means it proxies to a different API.',
  ).toMatchObject({ status: 200, body: { service: 'pulsedesk-api', version: E2E_API_VERSION } });
}
