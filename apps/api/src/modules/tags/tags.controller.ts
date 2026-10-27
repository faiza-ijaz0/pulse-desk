import { createTagRequestSchema, tagParamsSchema, updateTagRequestSchema } from '@pulsedesk/shared';
import type { RequestHandler } from 'express';
import { requestMeta, tenantOf } from '../../http/auth-context.ts';
import { parseRequest } from '../../http/validate.ts';
import type { TagsService } from './tags.service.ts';

export function createTagsController(service: TagsService) {
  const list: RequestHandler = async (req, res) => {
    res.json({ data: await service.list(tenantOf(req)) });
  };

  const create: RequestHandler = async (req, res) => {
    const input = parseRequest('body', createTagRequestSchema, req.body);
    res.status(201).json(await service.create(tenantOf(req), input, requestMeta(req)));
  };

  const update: RequestHandler = async (req, res) => {
    const { tagId } = parseRequest('params', tagParamsSchema, req.params);
    const input = parseRequest('body', updateTagRequestSchema, req.body);
    res.json(await service.update(tenantOf(req), tagId, input, requestMeta(req)));
  };

  const remove: RequestHandler = async (req, res) => {
    const { tagId } = parseRequest('params', tagParamsSchema, req.params);
    await service.remove(tenantOf(req), tagId, requestMeta(req));
    res.status(204).end();
  };

  return { list, create, update, remove };
}
