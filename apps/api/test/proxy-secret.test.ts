import { createPrismaClient } from '@pulsedesk/db';
import { problemDetailsSchema, readinessResponseSchema } from '@pulsedesk/shared';
import type { Router } from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApiRouter } from '../src/api-router.ts';
import { createApp } from '../src/app.ts';
import { PROXY_SECRET_HEADER } from '../src/http/middleware/proxy-secret.ts';
import { createLogger } from '../src/lib/logger.ts';
import { WEB_ORIGIN, buildTestApp, captureLogs, testEnv } from './helpers.ts';

const SECRET = 'unit-test-proxy-secret_0123456789abcdefghij';

// Nothing listens on port 1: any request that got past the proxy check and reached the
// database would fail with a 503 rather than pass silently.
const env = testEnv({
  PROXY_SHARED_SECRET: SECRET,
  DATABASE_URL: 'postgresql://pulsedesk:unused@127.0.0.1:1/pulsedesk',
});
const db = createPrismaClient({ connectionString: env.DATABASE_URL });
const logs = captureLogs();
const logger = createLogger({ level: 'info', version: 'test', destination: logs.stream });
const clock = { now: () => new Date() };
const apiRouter = createApiRouter({ env, db, logger, clock });
const app = createApp({ env, logger, clock, apiRouter, checkDatabase: () => Promise.resolve() });

afterAll(() => db.$disconnect());

type Method = 'get' | 'post' | 'patch' | 'delete';

/** Every route registered on the real API router, walked through nested routers. */
function registeredRoutes(router: Router): { method: Method; path: string }[] {
  type Layer = {
    route?: { path: string; methods: Record<string, boolean> };
    handle: { stack?: Layer[] };
  };
  const walk = (stack: Layer[]): { method: Method; path: string }[] =>
    stack.flatMap((layer) => {
      if (layer.route) {
        const { path, methods } = layer.route;
        return Object.keys(methods).map((method) => ({ method: method as Method, path }));
      }
      return layer.handle.stack ? walk(layer.handle.stack) : [];
    });
  return walk((router as unknown as { stack: Layer[] }).stack);
}

const API_ROUTES = registeredRoutes(apiRouter).map(({ method, path }) => ({
  method,
  path: `/api/v1${path.replace(':userId', '0b7c4c1e-6a43-4c1e-9f3a-6f1c2a9d8e01')}`,
}));

function expectGenericForbidden(res: request.Response) {
  expect(res.status).toBe(403);
  const body = problemDetailsSchema.parse(res.body);
  expect(body.code).toBe('FORBIDDEN');
  expect(body.detail).toBeUndefined();
  expect(JSON.stringify(res.body)).not.toMatch(/proxy|secret|header/i);
}

describe('proxy secret enforcement', () => {
  it('finds every feature route to check', () => {
    // Guards the walk itself: if it ever found nothing, the coverage test below would pass vacuously.
    expect(API_ROUTES).toEqual(
      expect.arrayContaining([
        { method: 'post', path: '/api/v1/auth/register' },
        { method: 'post', path: '/api/v1/auth/login' },
        { method: 'post', path: '/api/v1/auth/logout' },
        { method: 'get', path: '/api/v1/auth/session' },
        { method: 'post', path: '/api/v1/auth/active-organization' },
        { method: 'get', path: '/api/v1/organization' },
        { method: 'patch', path: '/api/v1/organization' },
        { method: 'get', path: '/api/v1/members' },
      ]),
    );
    expect(API_ROUTES.length).toBeGreaterThanOrEqual(10);
  });

  it.each(API_ROUTES)('rejects $method $path without the secret', async ({ method, path }) => {
    const res = await request(app)[method](path).set('Origin', WEB_ORIGIN).send({});
    expectGenericForbidden(res);
  });

  it.each([
    ['an incorrect secret', `${SECRET.slice(0, -1)}x`],
    ['a prefix of the secret', SECRET.slice(0, 20)],
    ['the secret with extra characters', `${SECRET}x`],
    ['an empty value', ''],
  ])('rejects %s', async (_label, value) => {
    const res = await request(app).get('/api/v1/auth/session').set(PROXY_SECRET_HEADER, value);
    expectGenericForbidden(res);
  });

  it('rejects a client copy that a proxy appended to instead of replacing', async () => {
    // What the API receives when a proxy appends: Node joins repeated headers with ", ".
    const res = await request(app)
      .get('/api/v1/auth/session')
      .set(PROXY_SECRET_HEADER, `attacker-value, ${SECRET}`);
    expectGenericForbidden(res);
  });

  it('rejects readiness checks, unknown paths and non-GET health calls that bypass the proxy', async () => {
    expectGenericForbidden(await request(app).get('/health/ready'));
    expectGenericForbidden(await request(app).get('/api/v2/anything'));
    expectGenericForbidden(await request(app).get('/'));
    expectGenericForbidden(await request(app).post('/health').send({}));
  });

  it('rejects CORS preflight requests that bypass the proxy', async () => {
    const res = await request(app)
      .options('/api/v1/auth/login')
      .set('Origin', WEB_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets proxied requests through to the normal protections', async () => {
    const proxied = (req: request.Test) => req.set(PROXY_SECRET_HEADER, SECRET);

    // Authentication still applies.
    const session = await proxied(request(app).get('/api/v1/auth/session'));
    expect(problemDetailsSchema.parse(session.body).code).toBe('UNAUTHENTICATED');

    // CSRF still applies.
    const foreign = await proxied(request(app).post('/api/v1/auth/login'))
      .set('Origin', 'https://evil.example')
      .send({ email: 'a@example.test', password: 'x' });
    expect(problemDetailsSchema.parse(foreign.body).code).toBe('CSRF_ORIGIN_MISMATCH');

    // Validation runs before the database is touched.
    const invalid = await proxied(request(app).post('/api/v1/auth/register'))
      .set('Origin', WEB_ORIGIN)
      .send({ email: 'nope' });
    expect(problemDetailsSchema.parse(invalid.body).code).toBe('VALIDATION_FAILED');

    const preflight = await proxied(request(app).options('/api/v1/auth/login'))
      .set('Origin', WEB_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');
    expect(preflight.status).toBe(204);

    const ready = await proxied(request(app).get('/health/ready')).expect(200);
    expect(readinessResponseSchema.parse(ready.body)).toEqual({
      status: 'ready',
      checks: { database: 'ok' },
    });
  });

  it('keeps liveness public for the host’s health checks', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'pulsedesk-api' });
    expect(JSON.stringify(res.body)).not.toMatch(/postgres|secret|127\.0\.0\.1/i);
    await request(app).head('/health').expect(200);
  });

  it('marks rejections uncacheable, so a shared cache can never replay them', async () => {
    const res = await request(app).get('/api/v1/auth/session');
    expect(res.status).toBe(403);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('never writes the secret to the logs, whether valid or not', async () => {
    await request(app).get('/api/v1/auth/session').set(PROXY_SECRET_HEADER, SECRET);
    await request(app).get('/api/v1/auth/session').set(PROXY_SECRET_HEADER, `${SECRET}-old`);
    expect(logs.text()).toContain('request completed');
    expect(logs.text()).not.toContain(SECRET.slice(0, 24));
  });
});

describe('without a configured proxy secret (development and tests only)', () => {
  it('serves requests directly, as the local dev proxy does not need to send one', async () => {
    const { app: direct } = buildTestApp({ checkDatabase: () => Promise.resolve() });
    await request(direct).get('/health/ready').expect(200);
  });

  it('cannot be built for production', () => {
    // parseEnv already refuses this; createApp refuses it too, for any other caller.
    const production = { ...testEnv(), NODE_ENV: 'production' as const };
    expect(() => createApp({ env: production, logger })).toThrow(/PROXY_SHARED_SECRET/);
  });
});
