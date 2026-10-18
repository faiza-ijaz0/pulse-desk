import type { RequestHandler } from 'express';
import type { HealthService, ReadinessService } from './health.service.ts';

export function createHealthController(service: HealthService): { liveness: RequestHandler } {
  return {
    liveness(_req, res) {
      res.set('Cache-Control', 'no-store').json(service.getLiveness());
    },
  };
}

export function createReadinessController(service: ReadinessService): {
  readiness: RequestHandler;
} {
  return {
    async readiness(_req, res) {
      const result = await service.getReadiness();
      res
        .status(result.status === 'ready' ? 200 : 503)
        .set('Cache-Control', 'no-store')
        .json(result);
    },
  };
}
