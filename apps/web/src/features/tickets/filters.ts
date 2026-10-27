import {
  ticketListQuerySchema,
  type TicketPriority,
  type TicketSort,
  type TicketStatus,
} from '@pulsedesk/shared';

/** The inbox filters that live in the page URL (`/tickets?status=OPEN&assignee=me`). */
export type TicketFilters = {
  status?: TicketStatus[];
  priority?: TicketPriority[];
  /** `me`, `unassigned` or a user ID. */
  assignee?: string;
  /** `none` or a team ID. */
  team?: string;
  tag?: string;
  /** A customer ID: that customer's tickets. */
  customer?: string;
  sort: TicketSort;
};

/** URL and API parameter order; the API accepts the same names and values. */
const FILTER_KEYS = ['status', 'priority', 'assignee', 'team', 'tag', 'customer', 'sort'] as const;
const DEFAULT_SORT: TicketSort = 'newest';

/**
 * Reads filters from the URL, validating each one with the API's own schema. A value the
 * API would reject (a typo, an edited link) is dropped rather than breaking the page.
 */
export function filtersFromSearchParams(params: URLSearchParams): TicketFilters {
  const filters: TicketFilters = { sort: DEFAULT_SORT };
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value === null) continue;
    const parsed = ticketListQuerySchema.safeParse({ [key]: value });
    if (!parsed.success) continue;
    const { data } = parsed;
    if (key === 'status' && data.status) filters.status = data.status;
    else if (key === 'priority' && data.priority) filters.priority = data.priority;
    else if (key === 'assignee' && data.assignee) filters.assignee = data.assignee;
    else if (key === 'team' && data.team) filters.team = data.team;
    else if (key === 'tag' && data.tag) filters.tag = data.tag;
    else if (key === 'customer' && data.customer) filters.customer = data.customer;
    else if (key === 'sort') filters.sort = data.sort;
  }
  return filters;
}

/** The URL form of `filters`; defaults are left out so a plain `/tickets` means "everything". */
export function filtersToSearchParams(filters: TicketFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.status?.length) params.set('status', filters.status.join(','));
  if (filters.priority?.length) params.set('priority', filters.priority.join(','));
  if (filters.assignee) params.set('assignee', filters.assignee);
  if (filters.team) params.set('team', filters.team);
  if (filters.tag) params.set('tag', filters.tag);
  if (filters.customer) params.set('customer', filters.customer);
  if (filters.sort !== DEFAULT_SORT) params.set('sort', filters.sort);
  return params;
}

export function hasActiveFilters(filters: TicketFilters): boolean {
  return (
    (filters.status?.length ?? 0) > 0 ||
    (filters.priority?.length ?? 0) > 0 ||
    filters.assignee !== undefined ||
    filters.team !== undefined ||
    filters.tag !== undefined ||
    filters.customer !== undefined
  );
}

/** `GET /api/v1/tickets` for one page of the filtered list. */
export function ticketListPath(filters: TicketFilters, cursor?: string): string {
  const params = filtersToSearchParams(filters);
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return query ? `/api/v1/tickets?${query}` : '/api/v1/tickets';
}
