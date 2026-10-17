import type { HealthResponse } from '@pulsedesk/shared';

export type Clock = { now: () => Date };

/**
 * Liveness only: "is this process able to serve HTTP?" It deliberately does not check
 * PostgreSQL or Redis — a dependency outage must not make the orchestrator restart
 * healthy API processes. Readiness (with dependency checks) arrives with those dependencies.
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
