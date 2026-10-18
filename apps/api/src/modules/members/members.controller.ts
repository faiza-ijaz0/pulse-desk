import { changeMemberRoleRequestSchema, memberParamsSchema } from '@pulsedesk/shared';
import type { RequestHandler } from 'express';
import { requestMeta, tenantOf } from '../../http/auth-context.ts';
import { parseRequest } from '../../http/validate.ts';
import type { MembersService } from './members.service.ts';

export function createMembersController(service: MembersService) {
  const list: RequestHandler = async (req, res) => {
    res.json({ data: await service.list(tenantOf(req)) });
  };

  const changeRole: RequestHandler = async (req, res) => {
    const { userId } = parseRequest('params', memberParamsSchema, req.params);
    const { role } = parseRequest('body', changeMemberRoleRequestSchema, req.body);
    res.json(await service.changeRole(tenantOf(req), userId, role, requestMeta(req)));
  };

  const remove: RequestHandler = async (req, res) => {
    const { userId } = parseRequest('params', memberParamsSchema, req.params);
    await service.remove(tenantOf(req), userId, requestMeta(req));
    res.status(204).end();
  };

  return { list, changeRole, remove };
}
