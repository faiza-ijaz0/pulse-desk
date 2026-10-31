import { createServer } from 'node:http';
import { createPrismaClient } from '@pulsedesk/db';
import { createApiRouter } from './api-router.ts';
import { createApp } from './app.ts';
import { parseEnv } from './config/env.ts';
import { createLogger } from './lib/logger.ts';
import { systemClock } from './lib/clock.ts';
import { createShutdown, registerProcessHandlers } from './lib/lifecycle.ts';
import { loadEnvFile } from './lib/load-env-file.ts';
import { createAutoCloseRepository } from './modules/auto-close/auto-close.repository.ts';
import {
  autoCloseIntervalMs,
  createAutoCloseScheduler,
} from './modules/auto-close/auto-close.scheduler.ts';
import { createAutoCloseService } from './modules/auto-close/auto-close.service.ts';
import { createSlaSweepRepository } from './modules/sla/sla-sweep.repository.ts';
import { createSlaSweepScheduler, slaSweepIntervalMs } from './modules/sla/sla-sweep.scheduler.ts';
import { createSlaSweepService } from './modules/sla/sla-sweep.service.ts';

async function main(): Promise<void> {
  loadEnvFile();

  const result = parseEnv(process.env);
  if (!result.ok) {
    // The logger is configured from env, so report invalid configuration directly.
    process.stderr.write(
      `\nPulseDesk API refused to start: invalid configuration\n${result.problems.map((p) => `  - ${p}`).join('\n')}\n\n` +
        'See .env.example and docs/development.md for every variable.\n\n',
    );
    process.exitCode = 1;
    return;
  }
  const env = result.env;

  const prettyStream =
    env.NODE_ENV === 'development' && process.stdout.isTTY
      ? (await import('pino-pretty')).default({ colorize: true, translateTime: 'SYS:HH:MM:ss.l' })
      : undefined;
  const logger = createLogger({
    level: env.LOG_LEVEL,
    version: env.APP_VERSION,
    ...(prettyStream && { destination: prettyStream }),
  });

  // Prisma connects lazily, so a database outage doesn't stop the process from starting
  // (GET /health stays liveness-only); requests that need the database fail with a 503.
  const db = createPrismaClient({ connectionString: env.DATABASE_URL });
  const apiRouter = createApiRouter({ env, db, logger, clock: systemClock });
  const server = createServer(
    createApp({
      env,
      logger,
      clock: systemClock,
      apiRouter,
      checkDatabase: () => db.$queryRaw`SELECT 1`,
    }),
  );
  server.keepAliveTimeout = 65_000; // longer than typical load-balancer idle timeouts
  server.headersTimeout = 66_000;

  // SLA breach sweep: in this process, on a timer (single API instance; docs/deployment.md).
  const sweepIntervalMs = slaSweepIntervalMs(env);
  const slaSweepService = createSlaSweepService({
    repository: createSlaSweepRepository(db),
    clock: systemClock,
    logger,
    batchSize: env.SLA_SWEEP_BATCH_SIZE,
  });
  const slaSweep =
    sweepIntervalMs === null
      ? undefined
      : createSlaSweepScheduler({
          intervalMs: sweepIntervalMs,
          logger,
          sweep: (options) => slaSweepService.sweep(options),
        });

  // Auto-close sweep: the same pattern, its own interval (single API instance).
  const autoCloseMs = autoCloseIntervalMs(env);
  const autoCloseService = createAutoCloseService({
    repository: createAutoCloseRepository(db),
    clock: systemClock,
    logger,
    batchSize: env.AUTO_CLOSE_BATCH_SIZE,
  });
  const autoClose =
    autoCloseMs === null
      ? undefined
      : createAutoCloseScheduler({
          intervalMs: autoCloseMs,
          logger,
          sweep: (options) => autoCloseService.sweep(options),
        });

  const shutdown = createShutdown({
    server,
    logger,
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    // Stop scheduling and let a running sweep finish its current ticket before the pool closes.
    onClose: async () => {
      await Promise.all([slaSweep?.stop(), autoClose?.stop()]);
      await db.$disconnect();
    },
  });
  registerProcessHandlers(shutdown, logger);

  server.on('error', (error) => {
    logger.fatal({ err: error }, 'HTTP server failed to start');
    process.exitCode = 1;
  });
  server.listen(env.API_PORT, env.API_HOST, () => {
    logger.info(
      { host: env.API_HOST, port: env.API_PORT, env: env.NODE_ENV },
      'PulseDesk API listening',
    );
    // Only once the server is up, so a failed start never leaves a sweep running.
    if (slaSweep) {
      slaSweep.start();
      logger.info(
        { intervalSeconds: env.SLA_SWEEP_INTERVAL_SECONDS },
        'SLA breach sweep scheduled',
      );
    } else {
      logger.info({ nodeEnv: env.NODE_ENV }, 'SLA breach sweep disabled');
    }
    if (autoClose) {
      autoClose.start();
      logger.info(
        { intervalSeconds: env.AUTO_CLOSE_SWEEP_INTERVAL_SECONDS },
        'Auto-close sweep scheduled',
      );
    } else {
      logger.info({ nodeEnv: env.NODE_ENV }, 'Auto-close sweep disabled');
    }
  });
}

void main();
