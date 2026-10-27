import { Writable } from 'node:stream';
import type { Router } from 'express';
import { createApp } from '../src/app.ts';
import { parseEnv, type Env } from '../src/config/env.ts';
import { createLogger } from '../src/lib/logger.ts';

export const WEB_ORIGIN = 'http://localhost:5173';

/** Test-only values. Unit tests never connect to this database; Prisma connects lazily. */
export const TEST_ENV_DEFAULTS = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  WEB_ORIGIN,
  DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
  SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789',
} as const;

export function testEnv(overrides: Record<string, string> = {}): Env {
  const result = parseEnv({ ...TEST_ENV_DEFAULTS, ...overrides });
  if (!result.ok) throw new Error(`Invalid test env: ${result.problems.join('; ')}`);
  return result.env;
}

/** Collects structured log lines so tests can assert on what was (and was not) logged. */
export function captureLogs() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { lines, stream, text: () => lines.map((l) => JSON.stringify(l)).join('\n') };
}

export function buildTestApp(
  options: {
    env?: Record<string, string>;
    apiRouter?: Router;
    checkDatabase?: () => Promise<unknown>;
  } = {},
) {
  const env = testEnv(options.env);
  const logs = captureLogs();
  const logger = createLogger({
    level: env.LOG_LEVEL,
    version: env.APP_VERSION,
    destination: logs.stream,
  });
  const app = createApp({
    env,
    logger,
    ...(options.apiRouter && { apiRouter: options.apiRouter }),
    ...(options.checkDatabase && { checkDatabase: options.checkDatabase }),
  });
  return { app, logs, env };
}

export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Every route registered on the real API router, walked through nested routers. */
export function registeredRoutes(router: Router): { method: Method; path: string }[] {
  type Layer = {
    route?: { path: string; methods: Record<string, boolean> };
    handle: { stack?: Layer[] };
  };
  const walk = (stack: Layer[]): { method: Method; path: string }[] =>
    stack.flatMap((layer) => {
      if (layer.route) {
        const { path, methods } = layer.route;
        // Express lists methods in lower case; these are the ones the API router uses.
        return Object.keys(methods).map((method) => ({ method: method as Method, path }));
      }
      return layer.handle.stack ? walk(layer.handle.stack) : [];
    });
  // Express keeps its route stack on the router function; it isn't part of the public type.
  return walk((router as unknown as { stack: Layer[] }).stack);
}
