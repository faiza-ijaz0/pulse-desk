import { teamSchema } from '@pulsedesk/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';

// Team lists are read with useTeamOptions (features/tickets/api), shared with the ticket
// filters. Changes are not optimistic: each waits for the server, then refreshes teams —
// and tickets, whose team badges and assignments a rename or delete can change.

function useTeamMutation<Input>(request: (input: Input) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['teams'] });
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
    },
  });
}

export function useCreateTeam() {
  return useTeamMutation((name: string) =>
    apiRequest('/api/v1/teams', { method: 'POST', body: { name }, schema: teamSchema }),
  );
}

export function useRenameTeam() {
  return useTeamMutation(({ teamId, name }: { teamId: string; name: string }) =>
    apiRequest(`/api/v1/teams/${teamId}`, { method: 'PATCH', body: { name }, schema: teamSchema }),
  );
}

export function useDeleteTeam() {
  return useTeamMutation((teamId: string) =>
    apiRequest(`/api/v1/teams/${teamId}`, { method: 'DELETE' }),
  );
}

export function useAddTeamMember() {
  return useTeamMutation(({ teamId, userId }: { teamId: string; userId: string }) =>
    apiRequest(`/api/v1/teams/${teamId}/members/${userId}`, { method: 'PUT', schema: teamSchema }),
  );
}

export function useRemoveTeamMember() {
  return useTeamMutation(({ teamId, userId }: { teamId: string; userId: string }) =>
    apiRequest(`/api/v1/teams/${teamId}/members/${userId}`, { method: 'DELETE' }),
  );
}
