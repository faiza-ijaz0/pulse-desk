import type { HealthResponse, ReadinessResponse } from '@pulsedesk/shared';
import type { Clock } from '../../lib/clock.ts';
import type { Logger } from '../../lib/logger.ts';

/**
 * Liveness: "is this process able to serve HTTP?" It deliberately does not check PostgreSQL
 * or Redis, so a dependency outage never makes the orchestrator restart healthy processes.
 */
export function createHealthService(deps: { clock: Clock; startedAt: Date; version: string }) {
  return {
    getLiveness(): HealthResponse {
      const now = deps.clock.now();
      return {
        status: 'ok',
        service: 'pulsedesk-api',
        version: deps.version,
        uptimeSeconds: Math.max(0, Math.floor((now.getTime() - deps.startedAt.getTime()) / 1000)),
        timestamp: now.toISOString(),
      };
    },
  };
}

export type HealthService = ReturnType<typeof createHealthService>;

/**
 * Readiness: "can this instance serve real requests?" — i.e. can it reach PostgreSQL. Load
 * balancers use it to route traffic, and deploys use it to verify the database before users
 * do. Failures are logged with their cause; the response never contains it.
 */
export function createReadinessService(deps: {
  checkDatabase: () => Promise<unknown>;
  logger: Logger;
}) {
  return {
    async getReadiness(): Promise<ReadinessResponse> {
      try {
        await deps.checkDatabase();
        return { status: 'ready', checks: { database: 'ok' } };
      } catch (error) {
        deps.logger.error({ err: error }, 'Readiness check failed: database unavailable');
        return { status: 'unavailable', checks: { database: 'unavailable' } };
      }
    },
  };
}

export type ReadinessService = ReturnType<typeof createReadinessService>;
