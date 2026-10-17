import type { RequestHandler } from 'express';
import type { HealthService } from './health.service.ts';

export function createHealthController(service: HealthService): { liveness: RequestHandler } {
  return {
    liveness(_req, res) {
      res.set('Cache-Control', 'no-store').json(service.getLiveness());
    },
  };
}
