import { problemDetailsSchema, type ProblemDetails } from '@pulsedesk/shared';
import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '../src/http/errors.ts';
import { parseRequest } from '../src/http/validate.ts';
import { WEB_ORIGIN, buildTestApp } from './helpers.ts';

/** Routes that exercise each failure path through the real middleware stack. */
function failingRoutes(): Router {
  const router = Router();
  router.get('/missing', () => {
    throw new NotFoundError('Ticket');
  });
  router.get('/conflict', async () => {
    await Promise.resolve();
    throw new ConflictError('Ticket was modified by someone else.');
  });
  router.get('/crash', () => {
    throw new Error('database password is hunter2');
  });
  router.get('/async-crash', async () => {
    await Promise.resolve();
    throw new TypeError('Cannot read properties of undefined');
  });
  router.post('/echo', (req, res) => {
    const body = parseRequest(
      'body',
      z.object({ email: z.email(), name: z.string().min(1) }),
      req.body,
    );
    res.status(201).json(body);
  });
  return router;
}

function build() {
  return buildTestApp({ apiRouter: failingRoutes() });
}

/** Asserts the RFC 9457 envelope and returns the body parsed against the shared contract. */
function expectProblem(res: request.Response, status: number, code: string): ProblemDetails {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const problem = problemDetailsSchema.parse(res.body);
  expect(problem.code).toBe(code);
  expect(problem.requestId).toBe(res.headers['x-request-id']);
  return problem;
}

describe('error responses', () => {
  it('returns ROUTE_NOT_FOUND for unknown routes', async () => {
    const { app } = build();
    const res = await request(app).get('/api/v1/does-not-exist');
    const problem = expectProblem(res, 404, 'ROUTE_NOT_FOUND');
    expect(problem.instance).toBe('/api/v1/does-not-exist');
  });

  it('maps AppError subclasses to their status and code', async () => {
    const { app } = build();
    expectProblem(await request(app).get('/api/v1/missing'), 404, 'NOT_FOUND');

    const conflict = expectProblem(await request(app).get('/api/v1/conflict'), 409, 'CONFLICT');
    expect(conflict.detail).toBe('Ticket was modified by someone else.');
  });

  it('hides unexpected errors behind a generic 500 but logs them with the request ID', async () => {
    const { app, logs } = build();

    const res = await request(app).get('/api/v1/crash');

    expectProblem(res, 500, 'INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    const logged = logs.lines.find((l) => l.msg === 'Unhandled error while processing request');
    expect(logged).toBeDefined();
    expect(logged?.requestId).toBe(res.headers['x-request-id']);
    expect(JSON.stringify(logged?.err)).toContain('hunter2'); // full detail stays server-side
  });

  it('catches rejected promises from async handlers', async () => {
    const { app } = build();
    expectProblem(await request(app).get('/api/v1/async-crash'), 500, 'INTERNAL_ERROR');
  });
});

describe('request body handling', () => {
  const post = (app: Parameters<typeof request>[0]) =>
    request(app).post('/api/v1/echo').set('Origin', WEB_ORIGIN);

  it('accepts a valid JSON body', async () => {
    const { app } = build();
    const res = await post(app).send({ email: 'a@example.com', name: 'Ada', extra: 'stripped' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ email: 'a@example.com', name: 'Ada' });
  });

  it('returns field-level VALIDATION_FAILED errors', async () => {
    const { app } = build();
    const res = await post(app).send({ email: 'nope', name: '' });
    const problem = expectProblem(res, 400, 'VALIDATION_FAILED');
    expect(problem.errors?.map((e) => e.path).sort()).toEqual(['body.email', 'body.name']);
  });

  it('rejects malformed JSON with BAD_REQUEST', async () => {
    const { app } = build();
    const res = await post(app).set('Content-Type', 'application/json').send('{"email":');
    expectProblem(res, 400, 'BAD_REQUEST');
  });

  it('rejects bodies over 100kb with PAYLOAD_TOO_LARGE', async () => {
    const { app } = build();
    const res = await post(app).send({ name: 'x'.repeat(110 * 1024), email: 'a@example.com' });
    expectProblem(res, 413, 'PAYLOAD_TOO_LARGE');
  });

  it('rejects non-JSON bodies with UNSUPPORTED_MEDIA_TYPE', async () => {
    const { app } = build();
    const res = await post(app).type('form').send('email=a@example.com&name=Ada');
    expectProblem(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
  });
});

describe('CSRF origin check', () => {
  it('rejects state-changing requests from an untrusted origin', async () => {
    const { app } = build();
    const res = await request(app)
      .post('/api/v1/echo')
      .set('Origin', 'https://evil.example')
      .send({ email: 'a@example.com', name: 'Ada' });
    expectProblem(res, 403, 'CSRF_ORIGIN_MISMATCH');
  });

  it('rejects state-changing requests with neither Origin nor Referer', async () => {
    const { app } = build();
    const res = await request(app)
      .post('/api/v1/echo')
      .send({ email: 'a@example.com', name: 'Ada' });
    expectProblem(res, 403, 'CSRF_ORIGIN_MISMATCH');
  });

  it('falls back to a trusted Referer', async () => {
    const { app } = build();
    const res = await request(app)
      .post('/api/v1/echo')
      .set('Referer', `${WEB_ORIGIN}/tickets`)
      .send({ email: 'a@example.com', name: 'Ada' });
    expect(res.status).toBe(201);
  });
});
