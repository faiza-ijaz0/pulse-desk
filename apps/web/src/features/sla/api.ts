import { slaPolicyResponseSchema, type UpdateSlaPolicyRequest } from '@pulsedesk/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';

const SLA_POLICY_QUERY_KEY = ['sla-policy'] as const;

export function useSlaPolicy() {
  return useQuery({
    queryKey: SLA_POLICY_QUERY_KEY,
    queryFn: ({ signal }) =>
      apiRequest('/api/v1/sla-policy', { schema: slaPolicyResponseSchema, signal }),
  });
}

/**
 * Replaces the default policy's targets (creating the policy if there is none). Existing
 * tickets keep their due dates, so no ticket query needs refreshing.
 */
export function useSaveSlaPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSlaPolicyRequest) =>
      apiRequest('/api/v1/sla-policy', {
        method: 'PUT',
        body: input,
        schema: slaPolicyResponseSchema,
      }),
    onSuccess: (response) => queryClient.setQueryData(SLA_POLICY_QUERY_KEY, response),
  });
}
