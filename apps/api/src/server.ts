import { createServer } from 'node:http';
import { createApp } from './app.ts';
import { parseEnv } from './config/env.ts';
import { createLogger } from './lib/logger.ts';
import { createShutdown, registerProcessHandlers } from './lib/lifecycle.ts';
import { loadEnvFile } from './lib/load-env-file.ts';

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

  const server = createServer(createApp({ env, logger }));
  server.keepAliveTimeout = 65_000; // longer than typical load-balancer idle timeouts
  server.headersTimeout = 66_000;

  const shutdown = createShutdown({ server, logger, timeoutMs: env.SHUTDOWN_TIMEOUT_MS });
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
  });
}

void main();
