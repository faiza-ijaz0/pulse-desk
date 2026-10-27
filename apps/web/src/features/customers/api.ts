import {
  customerListResponseSchema,
  customerSchema,
  type Customer,
  type UpdateCustomerInput,
} from '@pulsedesk/shared';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';

// Every key here is dropped when the session or organization changes (features/auth/session).
export const customerKeys = {
  list: (q: string) => ['customers', 'list', q] as const,
  detail: (id: string) => ['customers', 'detail', id] as const,
};

function listPath(q: string, cursor: string | undefined): string {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return query ? `/api/v1/customers?${query}` : '/api/v1/customers';
}

/** Customers ordered by email, filtered by `q` (name or email); `fetchNextPage` appends. */
export function useCustomerList(q: string) {
  return useInfiniteQuery({
    queryKey: customerKeys.list(q),
    queryFn: ({ pageParam, signal }) =>
      apiRequest(listPath(q, pageParam), { schema: customerListResponseSchema, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useCustomer(id: string | undefined) {
  return useQuery({
    queryKey: customerKeys.detail(id ?? ''),
    queryFn: ({ signal }) =>
      apiRequest(`/api/v1/customers/${id}`, { schema: customerSchema, signal }),
    enabled: id !== undefined,
  });
}

/**
 * Not optimistic: an email change can be refused (409) and both fields are shown in
 * several places, so the page updates only once the server has accepted the change.
 */
export function useUpdateCustomer(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateCustomerInput) =>
      apiRequest(`/api/v1/customers/${id}`, {
        method: 'PATCH',
        body: input,
        schema: customerSchema,
      }),
    onSuccess: (customer: Customer) => {
      queryClient.setQueryData(customerKeys.detail(id), customer);
      // Lists and tickets show the customer's name and email too.
      void queryClient.invalidateQueries({ queryKey: ['customers', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
    },
  });
}
