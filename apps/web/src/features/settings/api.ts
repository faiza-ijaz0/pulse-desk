import {
  organizationSchema,
  tagSchema,
  type CreateTagInput,
  type UpdateOrganizationRequest,
  type UpdateTagRequest,
} from '@pulsedesk/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SESSION_QUERY_KEY } from '@/features/auth/session';
import { apiRequest } from '@/lib/api-client';

export function useOrganization() {
  return useQuery({
    queryKey: ['organization'],
    queryFn: ({ signal }) =>
      apiRequest('/api/v1/organization', { schema: organizationSchema, signal }),
  });
}

/** The session lists organization names (workspace switcher), so it is refreshed too. */
export function useRenameOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateOrganizationRequest) =>
      apiRequest('/api/v1/organization', {
        method: 'PATCH',
        body: input,
        schema: organizationSchema,
      }),
    onSuccess: (organization) => {
      queryClient.setQueryData(['organization'], organization);
      void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    },
  });
}

// Tag lists are read with useTagOptions (features/tickets/api), shared with ticket filters
// and the tag editor. Changes wait for the server, then refresh tags and tickets (a rename
// or delete changes the tags shown on tickets).
function useTagMutation<Input>(request: (input: Input) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['tags'] });
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
    },
  });
}

export function useCreateTag() {
  return useTagMutation((input: CreateTagInput) =>
    apiRequest('/api/v1/tags', { method: 'POST', body: input, schema: tagSchema }),
  );
}

export function useUpdateTag() {
  return useTagMutation(({ tagId, ...input }: UpdateTagRequest & { tagId: string }) =>
    apiRequest(`/api/v1/tags/${tagId}`, { method: 'PATCH', body: input, schema: tagSchema }),
  );
}

export function useDeleteTag() {
  return useTagMutation((tagId: string) =>
    apiRequest(`/api/v1/tags/${tagId}`, { method: 'DELETE' }),
  );
}
