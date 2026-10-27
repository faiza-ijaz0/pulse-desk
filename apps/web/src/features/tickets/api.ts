import {
  memberListResponseSchema,
  type CreateMessageRequest,
  type CreateTicketInput,
  type TicketDetailResponse,
  type TicketSummary,
  type UpdateTicketRequest,
  tagListResponseSchema,
  teamListResponseSchema,
  ticketDetailResponseSchema,
  ticketListResponseSchema,
} from '@pulsedesk/shared';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import { ticketListPath, type TicketFilters } from './filters';

// Every key here is dropped when the session or organization changes (features/auth/session).
export const ticketKeys = {
  list: (filters: TicketFilters) => ['tickets', 'list', filters] as const,
  detail: (number: number) => ['tickets', 'detail', number] as const,
};

/** Cursor-paginated inbox; `fetchNextPage` appends the next page. */
export function useTicketList(filters: TicketFilters) {
  return useInfiniteQuery({
    queryKey: ticketKeys.list(filters),
    queryFn: ({ pageParam, signal }) =>
      apiRequest(ticketListPath(filters, pageParam), { schema: ticketListResponseSchema, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Keep showing the previous results while a filter change loads, instead of flashing
    // back to a skeleton on every selection.
    placeholderData: keepPreviousData,
  });
}

export function useTicketDetail(number: number | undefined) {
  return useQuery({
    queryKey: ticketKeys.detail(number ?? 0),
    queryFn: ({ signal }) =>
      apiRequest(`/api/v1/tickets/${number}`, { schema: ticketDetailResponseSchema, signal }),
    enabled: number !== undefined,
  });
}

// Filter options change rarely; one fetch per session is plenty.
const OPTIONS_STALE_TIME = 5 * 60_000;

export function useMemberOptions() {
  return useQuery({
    queryKey: ['members'],
    queryFn: ({ signal }) =>
      apiRequest('/api/v1/members', { schema: memberListResponseSchema, signal }),
    select: (response) => response.data,
    staleTime: OPTIONS_STALE_TIME,
  });
}

export function useTeamOptions() {
  return useQuery({
    queryKey: ['teams'],
    queryFn: ({ signal }) =>
      apiRequest('/api/v1/teams', { schema: teamListResponseSchema, signal }),
    select: (response) => response.data,
    staleTime: OPTIONS_STALE_TIME,
  });
}

export function useTagOptions() {
  return useQuery({
    queryKey: ['tags'],
    queryFn: ({ signal }) => apiRequest('/api/v1/tags', { schema: tagListResponseSchema, signal }),
    select: (response) => response.data,
    staleTime: OPTIONS_STALE_TIME,
  });
}

// ───────────────────────── Mutations ─────────────────────────
// Every mutation answers with the updated ticket, which replaces the cached detail. Lists
// are refetched afterwards, since a change can move a ticket in or out of a filter.

function storeTicket(queryClient: QueryClient, detail: TicketDetailResponse) {
  queryClient.setQueryData(ticketKeys.detail(detail.ticket.number), detail);
  void queryClient.invalidateQueries({ queryKey: ['tickets', 'list'] });
}

export function useCreateTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTicketInput) =>
      apiRequest('/api/v1/tickets', {
        method: 'POST',
        body: input,
        schema: ticketDetailResponseSchema,
      }),
    onSuccess: (detail) => storeTicket(queryClient, detail),
  });
}

export type TicketUpdate = {
  request: UpdateTicketRequest;
  /** What the ticket will look like, shown until the server answers. */
  optimistic: Partial<TicketSummary>;
};

/**
 * Property changes (status, priority, assignee, team, tags) are applied optimistically:
 * each is a single field the server either accepts as sent or rejects, so showing it
 * early is safe. A rejection restores the previous ticket; the server's answer always
 * replaces the guess, including timestamps the client can't know.
 */
export function useUpdateTicket(number: number) {
  const queryClient = useQueryClient();
  const key = ticketKeys.detail(number);
  return useMutation({
    mutationFn: ({ request }: TicketUpdate) =>
      apiRequest(`/api/v1/tickets/${number}`, {
        method: 'PATCH',
        body: request,
        schema: ticketDetailResponseSchema,
      }),
    onMutate: async ({ optimistic }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<TicketDetailResponse>(key);
      if (previous) {
        queryClient.setQueryData<TicketDetailResponse>(key, {
          ...previous,
          ticket: { ...previous.ticket, ...optimistic },
        });
      }
      return { previous };
    },
    onError: (_error, _update, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSuccess: (detail) => storeTicket(queryClient, detail),
  });
}

/**
 * Replies and notes are not optimistic: the message's author, time and position come from
 * the server, and a failed send must leave the draft in place for another try.
 */
export function useAddMessage(number: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMessageRequest) =>
      apiRequest(`/api/v1/tickets/${number}/messages`, {
        method: 'POST',
        body: input,
        schema: ticketDetailResponseSchema,
      }),
    onSuccess: (detail) => storeTicket(queryClient, detail),
  });
}
