import { Router } from 'express';
import { createHealthController, createReadinessController } from './health.controller.ts';
import type { HealthService, ReadinessService } from './health.service.ts';

export function healthRoutes(service: HealthService): Router {
  const controller = createHealthController(service);
  const router = Router();
  router.get('/health', controller.liveness);
  return router;
}

/** Mounted behind the global rate limit: unlike liveness, each call queries the database. */
export function readinessRoutes(service: ReadinessService): Router {
  const controller = createReadinessController(service);
  const router = Router();
  router.get('/health/ready', controller.readiness);
  return router;
}
