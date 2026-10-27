import { z } from 'zod';
import { customerSchema } from './customers.ts';
import { searchTextSchema } from './search-text.ts';
import { ticketSummarySchema } from './tickets.ts';

/** Results per type: enough to pick from, small enough to stay fast and readable. */
export const SEARCH_RESULT_LIMIT = 8;

/** `GET /api/v1/search?q=`. */
export const searchQuerySchema = z.strictObject({ q: searchTextSchema });
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/**
 * Matches in the active organization. Tickets match on number (`42` or `#42`) and subject;
 * customers on name and email. Ticket rows carry no message content.
 */
export const searchResponseSchema = z.object({
  tickets: z.array(ticketSummarySchema),
  customers: z.array(customerSchema),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
