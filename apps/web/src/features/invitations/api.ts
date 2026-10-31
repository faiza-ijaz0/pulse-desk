import {
  authSessionSchema,
  invitationPreviewSchema,
  type RegisterWithInvitationRequest,
} from '@pulsedesk/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SESSION_QUERY_KEY, replaceSession } from '@/features/auth/session';
import { apiRequest } from '@/lib/api-client';

// The token is sent in request bodies only, never in a URL. It is part of the preview's query
// key (memory only), so opening another link fetches that invitation.

export function useInvitationPreview(token: string | null) {
  return useQuery({
    queryKey: ['invitation-preview', token],
    queryFn: () =>
      apiRequest('/api/v1/invitations/preview', {
        method: 'POST',
        body: { token },
        schema: invitationPreviewSchema,
      }),
    enabled: token !== null,
    retry: false,
    staleTime: Infinity,
  });
}

export function useAcceptInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      apiRequest('/api/v1/invitations/accept', {
        method: 'POST',
        body: { token },
        schema: authSessionSchema,
      }),
    onSuccess: (session) => replaceSession(queryClient, session),
  });
}

export function useRegisterWithInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RegisterWithInvitationRequest) =>
      apiRequest('/api/v1/invitations/register', {
        method: 'POST',
        body: input,
        schema: authSessionSchema,
      }),
    onSuccess: (session) => replaceSession(queryClient, session),
  });
}

/**
 * Signing in and accepting, as one step. The session cache changes only at the end, so the
 * form that started it stays mounted (a signed-in session would replace it) until both are
 * done. If accepting fails after signing in, the session is re-read: the page then shows the
 * signed-in state, where accepting can be tried again.
 */
export function useSignInAndAccept() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { email: string; password: string; token: string }) => {
      await apiRequest('/api/v1/auth/login', {
        method: 'POST',
        body: { email: input.email, password: input.password },
        schema: authSessionSchema,
      });
      return apiRequest('/api/v1/invitations/accept', {
        method: 'POST',
        body: { token: input.token },
        schema: authSessionSchema,
      });
    },
    onSuccess: (session) => replaceSession(queryClient, session),
    onError: () => void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY }),
  });
}
