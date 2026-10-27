import { searchQuerySchema } from '@pulsedesk/shared';
import type { RequestHandler } from 'express';
import { tenantOf } from '../../http/auth-context.ts';
import { parseRequest } from '../../http/validate.ts';
import type { SearchService } from './search.service.ts';

export function createSearchController(service: SearchService) {
  const search: RequestHandler = async (req, res) => {
    const query = parseRequest('query', searchQuerySchema, req.query);
    res.json(await service.search(tenantOf(req), query));
  };

  return { search };
}
