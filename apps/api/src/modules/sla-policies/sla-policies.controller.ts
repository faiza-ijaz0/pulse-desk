import { updateSlaPolicyRequestSchema } from '@pulsedesk/shared';
import type { RequestHandler } from 'express';
import { requestMeta, tenantOf } from '../../http/auth-context.ts';
import { parseRequest } from '../../http/validate.ts';
import type { SlaPoliciesService } from './sla-policies.service.ts';

export function createSlaPoliciesController(service: SlaPoliciesService) {
  const getDefault: RequestHandler = async (req, res) => {
    res.json(await service.getDefault(tenantOf(req)));
  };

  const saveDefault: RequestHandler = async (req, res) => {
    const input = parseRequest('body', updateSlaPolicyRequestSchema, req.body);
    res.json(await service.saveDefault(tenantOf(req), input, requestMeta(req)));
  };

  return { getDefault, saveDefault };
}
