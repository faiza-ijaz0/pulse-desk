import {
  createInvitationResponseSchema,
  invitationListResponseSchema,
  memberSchema,
  teamSchema,
  type CreateInvitationRequest,
  type Role,
} from '@pulsedesk/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SESSION_QUERY_KEY } from '@/features/auth/session';
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

// Members are read with useMemberOptions (features/tickets/api). Role changes and removals
// refresh members, tickets (assignees), invitations (a removed or demoted admin's open
// invitations are revoked) and the session: a change to one's own membership changes what
// the session may do, or which organizations it has.

function useMemberMutation<Input>(request: (input: Input) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['members'] });
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['invitations'] });
      void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    },
  });
}

export function useChangeMemberRole() {
  return useMemberMutation(({ userId, role }: { userId: string; role: Role }) =>
    apiRequest(`/api/v1/members/${userId}`, {
      method: 'PATCH',
      body: { role },
      schema: memberSchema,
    }),
  );
}

export function useRemoveMember() {
  return useMemberMutation((userId: string) =>
    apiRequest(`/api/v1/members/${userId}`, { method: 'DELETE' }),
  );
}

export function useInvitations(enabled: boolean) {
  return useQuery({
    queryKey: ['invitations'],
    queryFn: ({ signal }) =>
      apiRequest('/api/v1/invitations', { schema: invitationListResponseSchema, signal }),
    select: (response) => response.data,
    enabled,
  });
}

/** The response holds the invitation's token: it lives only in the dialog that shows it. */
export function useCreateInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInvitationRequest) =>
      apiRequest('/api/v1/invitations', {
        method: 'POST',
        body: input,
        schema: createInvitationResponseSchema,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['invitations'] }),
  });
}

export function useRevokeInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      apiRequest(`/api/v1/invitations/${invitationId}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invitations'] }),
  });
}
