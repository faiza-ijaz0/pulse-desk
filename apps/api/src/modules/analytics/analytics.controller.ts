import { analyticsQuerySchema } from '@pulsedesk/shared';
import type { RequestHandler } from 'express';
import { tenantOf } from '../../http/auth-context.ts';
import { parseRequest } from '../../http/validate.ts';
import type { AnalyticsService } from './analytics.service.ts';

export function createAnalyticsController(service: AnalyticsService) {
  // The organization and the scope come from the session; the query only picks the days.
  const report: RequestHandler = async (req, res) => {
    const query = parseRequest('query', analyticsQuerySchema, req.query);
    res.json(await service.report(tenantOf(req), query));
  };

  return { report };
}
