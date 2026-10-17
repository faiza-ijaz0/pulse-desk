import type { Server } from 'node:http';
import type { Logger } from './logger.ts';

export type ShutdownOptions = {
  server: Server;
  logger: Logger;
  timeoutMs: number;
  /** Additional resources to release after HTTP stops accepting work (DB pools, queues…). */
  onClose?: () => Promise<void>;
  exit?: (code: number) => void;
};

/**
 * Returns an idempotent shutdown routine:
 *  1. stop accepting new connections and close idle keep-alive sockets;
 *  2. let in-flight requests finish, up to `timeoutMs`;
 *  3. force-close remaining sockets if the deadline passes;
 *  4. release other resources, then exit with 0 (clean) or 1 (forced / failed).
 */
export function createShutdown({
  server,
  logger,
  timeoutMs,
  onClose,
  exit = (code) => process.exit(code),
}: ShutdownOptions) {
  let shuttingDown: Promise<void> | undefined;

  return function shutdown(reason: string, exitCode = 0): Promise<void> {
    if (shuttingDown) return shuttingDown;
    logger.info({ reason, timeoutMs }, 'Shutting down');

    shuttingDown = (async () => {
      let code = exitCode;
      const forceTimer = setTimeout(() => {
        logger.warn('Shutdown deadline reached; closing remaining connections');
        code = 1;
        server.closeAllConnections();
      }, timeoutMs);
      forceTimer.unref();

      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
          server.closeIdleConnections();
        });
        await onClose?.();
        logger.info('Shutdown complete');
      } catch (error) {
        code = 1;
        logger.error({ err: error }, 'Error during shutdown');
      } finally {
        clearTimeout(forceTimer);
        logger.flush();
        exit(code);
      }
    })();

    return shuttingDown;
  };
}

/** Wires OS signals and fatal process errors to the shutdown routine. */
export function registerProcessHandlers(
  shutdown: (reason: string, exitCode?: number) => Promise<void>,
  logger: Logger,
) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void shutdown(signal));
  }
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    void shutdown('uncaughtException', 1);
  });
}
