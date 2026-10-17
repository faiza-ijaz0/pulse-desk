import { problemDetailsSchema } from '@pulsedesk/shared';
import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { WEB_ORIGIN, buildTestApp } from './helpers.ts';

function pingRouter(): Router {
  const router = Router();
  router.get('/ping', (_req, res) => {
    res.json({ pong: true });
  });
  return router;
}

describe('request IDs', () => {
  it('echoes a safe inbound X-Request-Id', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/health').set('X-Request-Id', 'edge-abc_123.4');
    expect(res.headers['x-request-id']).toBe('edge-abc_123.4');
  });

  it('replaces an unsafe inbound X-Request-Id', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/health').set('X-Request-Id', 'bad id\twith "quotes"');
    expect(res.headers['x-request-id']).not.toContain('bad');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stamps request log lines with the request ID', async () => {
    const { app, logs } = buildTestApp({ apiRouter: pingRouter() });
    const res = await request(app).get('/api/v1/ping').expect(200);
    const line = logs.lines.find((l) => l.msg === 'request completed');
    expect(line?.requestId).toBe(res.headers['x-request-id']);
  });
});

describe('log redaction', () => {
  it('never writes cookies or authorization headers to the logs', async () => {
    const { app, logs } = buildTestApp({ apiRouter: pingRouter() });

    await request(app)
      .get('/api/v1/ping')
      .set('Cookie', 'pd_sid=super-secret-session-token')
      .set('Authorization', 'Bearer super-secret-bearer')
      .expect(200);

    const text = logs.text();
    expect(text).toContain('request completed');
    expect(text).not.toContain('super-secret-session-token');
    expect(text).not.toContain('super-secret-bearer');
    expect(text).toContain('[REDACTED]');
  });
});

describe('rate limiting', () => {
  it('returns RATE_LIMITED problems with standard headers once the budget is spent', async () => {
    const { app } = buildTestApp({
      env: { RATE_LIMIT_GLOBAL_PER_MINUTE: '3' },
      apiRouter: pingRouter(),
    });

    for (let i = 0; i < 3; i++) {
      await request(app).get('/api/v1/ping').expect(200);
    }
    const res = await request(app).get('/api/v1/ping');

    expect(res.status).toBe(429);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(problemDetailsSchema.parse(res.body).code).toBe('RATE_LIMITED');
    expect(res.headers.ratelimit).toBeDefined();
    expect(res.headers['retry-after']).toBeDefined();
  });
});

describe('CORS', () => {
  it('allows the configured web origin with credentials', async () => {
    const { app } = buildTestApp({ apiRouter: pingRouter() });
    const res = await request(app).get('/api/v1/ping').set('Origin', WEB_ORIGIN).expect(200);
    expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('gives other origins no CORS grant', async () => {
    const { app } = buildTestApp({ apiRouter: pingRouter() });
    const res = await request(app)
      .get('/api/v1/ping')
      .set('Origin', 'https://evil.example')
      .expect(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers preflight requests for the allowed origin', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .options('/api/v1/anything')
      .set('Origin', WEB_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });
});

describe('API responses', () => {
  it('are marked uncacheable', async () => {
    const { app } = buildTestApp({ apiRouter: pingRouter() });
    const res = await request(app).get('/api/v1/ping').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
