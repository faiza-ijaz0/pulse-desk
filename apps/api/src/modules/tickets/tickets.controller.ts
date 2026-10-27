import {
  createMessageRequestSchema,
  createTicketRequestSchema,
  ticketDetailQuerySchema,
  ticketListQuerySchema,
  ticketParamsSchema,
  updateTicketRequestSchema,
} from '@pulsedesk/shared';
import type { RequestHandler } from 'express';
import { tenantOf } from '../../http/auth-context.ts';
import { parseRequest } from '../../http/validate.ts';
import type { TicketsService } from './tickets.service.ts';

export function createTicketsController(service: TicketsService) {
  const list: RequestHandler = async (req, res) => {
    const query = parseRequest('query', ticketListQuerySchema, req.query);
    res.json(await service.list(tenantOf(req), query));
  };

  const get: RequestHandler = async (req, res) => {
    const { number } = parseRequest('params', ticketParamsSchema, req.params);
    parseRequest('query', ticketDetailQuerySchema, req.query);
    res.json(await service.get(tenantOf(req), number));
  };

  const create: RequestHandler = async (req, res) => {
    const input = parseRequest('body', createTicketRequestSchema, req.body);
    const created = await service.create(tenantOf(req), input);
    res.status(201).location(`/api/v1/tickets/${created.ticket.number}`).json(created);
  };

  const update: RequestHandler = async (req, res) => {
    const { number } = parseRequest('params', ticketParamsSchema, req.params);
    const input = parseRequest('body', updateTicketRequestSchema, req.body);
    res.json(await service.update(tenantOf(req), number, input));
  };

  const addMessage: RequestHandler = async (req, res) => {
    const { number } = parseRequest('params', ticketParamsSchema, req.params);
    const input = parseRequest('body', createMessageRequestSchema, req.body);
    res.status(201).json(await service.addMessage(tenantOf(req), number, input));
  };

  return { list, get, create, update, addMessage };
}
