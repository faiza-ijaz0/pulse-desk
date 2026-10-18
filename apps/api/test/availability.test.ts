import { Prisma, createPrismaClient } from '@pulsedesk/db';
import { problemDetailsSchema, readinessResponseSchema } from '@pulsedesk/shared';
import { Router } from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApiRouter } from '../src/api-router.ts';
import { createApp } from '../src/app.ts';
import { createLogger } from '../src/lib/logger.ts';
import { WEB_ORIGIN, buildTestApp, captureLogs, testEnv } from './helpers.ts';

// Nothing listens on port 1, so connections are refused immediately: a real "database
// unreachable" failure without depending on any external service.
const UNREACHABLE_DATABASE_URL = 'postgresql://pulsedesk:not-the-password@127.0.0.1:1/pulsedesk';

function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError(
    'Authentication failed against the database server for `pulsedesk`',
    { code, clientVersion: 'test' },
  );
}

describe('database outages', () => {
  it('answer 503 SERVICE_UNAVAILABLE without internals, and log the code with the request ID', async () => {
    const router = Router();
    router.get('/needs-db', () => {
      throw prismaError('P1000');
    });
    const { app, logs } = buildTestApp({ apiRouter: router });

    const res = await request(app).get('/api/v1/needs-db').expect(503);

    expect(problemDetailsSchema.parse(res.body).code).toBe('SERVICE_UNAVAILABLE');
    expect(res.headers['retry-after']).toBe('30');
    expect(JSON.stringify(res.body)).not.toMatch(/P1000|Authentication|pulsedesk/);

    const line = logs.lines.find((l) => l.msg === 'Database unavailable');
    expect(line).toMatchObject({ errorCode: 'P1000', requestId: res.headers['x-request-id'] });
  });

  it('keeps query errors that are not outages as a generic 500 with an error code in the log', async () => {
    const router = Router();
    router.get('/bug', () => {
      throw prismaError('P2025');
    });
    const { app, logs } = buildTestApp({ apiRouter: router });

    const res = await request(app).get('/api/v1/bug').expect(500);
    expect(problemDetailsSchema.parse(res.body).code).toBe('INTERNAL_ERROR');
    const line = logs.lines.find((l) => l.msg === 'Unhandled error while processing request');
    expect(line?.errorCode).toBe('P2025');
  });

  describe('through the real modules, with the database unreachable', () => {
    const env = testEnv({ DATABASE_URL: UNREACHABLE_DATABASE_URL });
    const db = createPrismaClient({ connectionString: env.DATABASE_URL });
    const logs = captureLogs();
    const logger = createLogger({ level: 'info', version: 'test', destination: logs.stream });
    const clock = { now: () => new Date() };
    const app = createApp({
      env,
      logger,
      clock,
      apiRouter: createApiRouter({ env, db, logger, clock }),
      checkDatabase: () => db.$queryRaw`SELECT 1`,
    });

    afterAll(() => db.$disconnect());

    it('reports registration as temporarily unavailable, not as a generic failure', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .set('Origin', WEB_ORIGIN)
        .send({
          name: 'Outage Test',
          email: 'outage@example.test',
          password: 'a-long-enough-password',
          organizationName: 'Outage Co',
        })
        .expect(503);

      expect(problemDetailsSchema.parse(res.body).code).toBe('SERVICE_UNAVAILABLE');
      expect(logs.lines.find((l) => l.msg === 'Database unavailable')?.errorCode).toBe('P1001');
      expect(logs.text()).not.toContain('not-the-password');
      expect(logs.text()).not.toContain('a-long-enough-password');
    });

    it('still validates input before touching the database', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .set('Origin', WEB_ORIGIN)
        .send({ name: '', email: 'nope', password: 'short', organizationName: '' })
        .expect(400);
      expect(problemDetailsSchema.parse(res.body).code).toBe('VALIDATION_FAILED');
    });

    it('fails readiness while liveness stays up', async () => {
      const ready = await request(app).get('/health/ready').expect(503);
      expect(readinessResponseSchema.parse(ready.body)).toEqual({
        status: 'unavailable',
        checks: { database: 'unavailable' },
      });
      expect(JSON.stringify(ready.body)).not.toContain('127.0.0.1');
      await request(app).get('/health').expect(200);
    });
  });

  it('reports ready when the database answers', async () => {
    const { app } = buildTestApp({ checkDatabase: () => Promise.resolve() });
    const res = await request(app).get('/health/ready').expect(200);
    expect(readinessResponseSchema.parse(res.body).status).toBe('ready');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
