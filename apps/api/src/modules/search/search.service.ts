import { SEARCH_RESULT_LIMIT, type SearchQuery, type SearchResponse } from '@pulsedesk/shared';
import type { TenantContext } from '../../http/auth-context.ts';
import type { Clock } from '../../lib/clock.ts';
import type { CustomersRepository } from '../customers/customers.repository.ts';
import type { CustomersService } from '../customers/customers.service.ts';
import type { TicketsRepository } from '../tickets/tickets.repository.ts';
import { toSummary } from '../tickets/tickets.service.ts';

const MAX_TICKET_NUMBER = 2_147_483_647;

/** `42` or `#42` as a ticket number, if the text is one. */
function ticketNumberIn(text: string): number | null {
  const match = /^#?(\d{1,10})$/.exec(text);
  if (!match) return null;
  const number = Number(match[1]);
  return number >= 1 && number <= MAX_TICKET_NUMBER ? number : null;
}

/**
 * Global search over the active organization's tickets (number and subject) and customers
 * (name and email). Text is matched literally and case-insensitively through bound
 * parameters; results per type are capped and deterministically ordered. Message content
 * is not searched, so internal notes can never surface here.
 */
export function createSearchService(deps: {
  tickets: TicketsRepository;
  customers: CustomersRepository;
  customerDtos: Pick<CustomersService, 'withCounts'>;
  clock: Clock;
}) {
  return {
    async search(tenant: TenantContext, { q }: SearchQuery): Promise<SearchResponse> {
      const { organizationId } = tenant;
      const [tickets, customers] = await Promise.all([
        deps.tickets.search(organizationId, q, ticketNumberIn(q), SEARCH_RESULT_LIMIT),
        deps.customers.list(organizationId, { text: q, take: SEARCH_RESULT_LIMIT }),
      ]);
      const now = deps.clock.now();
      return {
        tickets: tickets.map((row) => toSummary(row, now)),
        customers: await deps.customerDtos.withCounts(organizationId, customers),
      };
    },
  };
}

export type SearchService = ReturnType<typeof createSearchService>;
