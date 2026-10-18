import { updateOrganizationRequestSchema } from '@pulsedesk/shared';
import type { RequestHandler } from 'express';
import { requestMeta, tenantOf } from '../../http/auth-context.ts';
import { parseRequest } from '../../http/validate.ts';
import type { OrganizationsService } from './organizations.service.ts';

export function createOrganizationsController(service: OrganizationsService) {
  const getCurrent: RequestHandler = async (req, res) => {
    res.json(await service.getCurrent(tenantOf(req)));
  };

  const update: RequestHandler = async (req, res) => {
    const input = parseRequest('body', updateOrganizationRequestSchema, req.body);
    res.json(await service.update(tenantOf(req), input, requestMeta(req)));
  };

  return { getCurrent, update };
}
