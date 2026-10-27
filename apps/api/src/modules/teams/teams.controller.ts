import {
  createTeamRequestSchema,
  teamMemberParamsSchema,
  teamParamsSchema,
  updateTeamRequestSchema,
} from '@pulsedesk/shared';
import type { RequestHandler } from 'express';
import { requestMeta, tenantOf } from '../../http/auth-context.ts';
import { parseRequest } from '../../http/validate.ts';
import type { TeamsService } from './teams.service.ts';

export function createTeamsController(service: TeamsService) {
  const list: RequestHandler = async (req, res) => {
    res.json({ data: await service.list(tenantOf(req)) });
  };

  const create: RequestHandler = async (req, res) => {
    const { name } = parseRequest('body', createTeamRequestSchema, req.body);
    res.status(201).json(await service.create(tenantOf(req), name, requestMeta(req)));
  };

  const rename: RequestHandler = async (req, res) => {
    const { teamId } = parseRequest('params', teamParamsSchema, req.params);
    const { name } = parseRequest('body', updateTeamRequestSchema, req.body);
    res.json(await service.rename(tenantOf(req), teamId, name, requestMeta(req)));
  };

  const remove: RequestHandler = async (req, res) => {
    const { teamId } = parseRequest('params', teamParamsSchema, req.params);
    await service.remove(tenantOf(req), teamId, requestMeta(req));
    res.status(204).end();
  };

  const addMember: RequestHandler = async (req, res) => {
    const { teamId, userId } = parseRequest('params', teamMemberParamsSchema, req.params);
    res.json(await service.addMember(tenantOf(req), teamId, userId, requestMeta(req)));
  };

  const removeMember: RequestHandler = async (req, res) => {
    const { teamId, userId } = parseRequest('params', teamMemberParamsSchema, req.params);
    await service.removeMember(tenantOf(req), teamId, userId, requestMeta(req));
    res.status(204).end();
  };

  return { list, create, rename, remove, addMember, removeMember };
}
