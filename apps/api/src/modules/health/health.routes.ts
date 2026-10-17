import { Router } from 'express';
import { createHealthController } from './health.controller.ts';
import type { HealthService } from './health.service.ts';

export function healthRoutes(service: HealthService): Router {
  const controller = createHealthController(service);
  const router = Router();
  router.get('/health', controller.liveness);
  return router;
}
