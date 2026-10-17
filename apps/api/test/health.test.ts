import { healthResponseSchema } from '@pulsedesk/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers.ts';

describe('GET /health', () => {
  it('reports liveness with the shared response contract', async () => {
    const { app } = buildTestApp({ env: { APP_VERSION: '1.2.3' } });

    const res = await request(app).get('/health').expect(200);

    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = healthResponseSchema.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.version).toBe('1.2.3');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sends security headers and hides the framework', async () => {
    const { app } = buildTestApp();

    const res = await request(app).get('/health').expect(200);

    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('returns a request ID header', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/health').expect(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is never rate limited, so orchestrator probes cannot be throttled', async () => {
    const { app } = buildTestApp({ env: { RATE_LIMIT_GLOBAL_PER_MINUTE: '2' } });

    for (let i = 0; i < 5; i++) {
      await request(app).get('/health').expect(200);
    }
  });

  it('is not written to the request log', async () => {
    const { app, logs } = buildTestApp();
    await request(app).get('/health').expect(200);
    expect(logs.lines.filter((l) => l.msg === 'request completed')).toHaveLength(0);
  });
});
