import {
  encodeCustomerCursor,
  type Customer,
  type CustomerListQuery,
  type CustomerListResponse,
  type UpdateCustomerInput,
} from '@pulsedesk/shared';
import type { RequestMeta, TenantContext } from '../../http/auth-context.ts';
import { ConflictError, NotFoundError } from '../../http/errors.ts';
import {
  CustomerEmailTakenError,
  type CustomerRow,
  type CustomersRepository,
  type TicketCounts,
} from './customers.repository.ts';

const NO_TICKETS: TicketCounts = { ticketCount: 0, activeTicketCount: 0 };

function toDto(row: CustomerRow, counts: TicketCounts = NO_TICKETS): Customer {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.createdAt.toISOString(),
    ...counts,
  };
}

/**
 * Customers of the active organization. Their ticket history is served by the ticket list
 * (`GET /tickets?customer=`), which carries no message content, so nothing here can expose
 * internal notes. A customer ID from another organization is not found (404), exactly like
 * one that never existed.
 */
export function createCustomersService({ repository }: { repository: CustomersRepository }) {
  /** DTOs with ticket counts, fetched for the whole set in one query. */
  async function withCounts(organizationId: string, rows: CustomerRow[]): Promise<Customer[]> {
    const counts = await repository.ticketCounts(
      organizationId,
      rows.map((row) => row.id),
    );
    return rows.map((row) => toDto(row, counts.get(row.id)));
  }

  async function withCountsOne(organizationId: string, row: CustomerRow): Promise<Customer> {
    const counts = await repository.ticketCounts(organizationId, [row.id]);
    return toDto(row, counts.get(row.id));
  }

  return {
    withCounts,

    async list(tenant: TenantContext, query: CustomerListQuery): Promise<CustomerListResponse> {
      // One extra row tells whether another page exists.
      const rows = await repository.list(tenant.organizationId, {
        text: query.q,
        after: query.cursor,
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        data: await withCounts(tenant.organizationId, page),
        nextCursor:
          rows.length > query.limit && last ? encodeCustomerCursor({ email: last.email }) : null,
      };
    },

    async get(tenant: TenantContext, customerId: string): Promise<Customer> {
      const row = await repository.find(tenant.organizationId, customerId);
      if (!row) throw new NotFoundError('Customer');
      return withCountsOne(tenant.organizationId, row);
    },

    async update(
      tenant: TenantContext,
      customerId: string,
      input: UpdateCustomerInput,
      meta: RequestMeta,
    ): Promise<Customer> {
      try {
        const row = await repository.update(tenant.organizationId, customerId, input, {
          actorUserId: tenant.userId,
          ipAddress: meta.ipAddress,
          requestId: tenant.requestId,
        });
        if (!row) throw new NotFoundError('Customer');
        return await withCountsOne(tenant.organizationId, row);
      } catch (error) {
        if (error instanceof CustomerEmailTakenError) {
          throw new ConflictError('Another customer in this organization already uses this email.');
        }
        throw error;
      }
    },
  };
}

export type CustomersService = ReturnType<typeof createCustomersService>;
