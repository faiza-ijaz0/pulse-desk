import { Writable } from 'node:stream';
import type { Router } from 'express';
import { createApp } from '../src/app.ts';
import { parseEnv, type Env } from '../src/config/env.ts';
import { createLogger } from '../src/lib/logger.ts';

export const WEB_ORIGIN = 'http://localhost:5173';

export function testEnv(overrides: Record<string, string> = {}): Env {
  const result = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'info', WEB_ORIGIN, ...overrides });
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

export function buildTestApp(options: { env?: Record<string, string>; apiRouter?: Router } = {}) {
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
  });
  return { app, logs, env };
}
