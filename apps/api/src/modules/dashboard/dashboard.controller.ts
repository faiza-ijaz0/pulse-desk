import type { RequestHandler } from 'express';
import { tenantOf } from '../../http/auth-context.ts';
import type { DashboardService } from './dashboard.service.ts';

export function createDashboardController(service: DashboardService) {
  // No parameters: the organization and the scope come from the session, never the request.
  const summary: RequestHandler = async (req, res) => {
    res.json(await service.summary(tenantOf(req)));
  };

  return { summary };
}
