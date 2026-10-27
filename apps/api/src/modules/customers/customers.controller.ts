import {
  customerListQuerySchema,
  customerParamsSchema,
  updateCustomerRequestSchema,
} from '@pulsedesk/shared';
import type { RequestHandler } from 'express';
import { requestMeta, tenantOf } from '../../http/auth-context.ts';
import { parseRequest } from '../../http/validate.ts';
import type { CustomersService } from './customers.service.ts';

export function createCustomersController(service: CustomersService) {
  const list: RequestHandler = async (req, res) => {
    const query = parseRequest('query', customerListQuerySchema, req.query);
    res.json(await service.list(tenantOf(req), query));
  };

  const get: RequestHandler = async (req, res) => {
    const { customerId } = parseRequest('params', customerParamsSchema, req.params);
    res.json(await service.get(tenantOf(req), customerId));
  };

  const update: RequestHandler = async (req, res) => {
    const { customerId } = parseRequest('params', customerParamsSchema, req.params);
    const input = parseRequest('body', updateCustomerRequestSchema, req.body);
    res.json(await service.update(tenantOf(req), customerId, input, requestMeta(req)));
  };

  return { list, get, update };
}
