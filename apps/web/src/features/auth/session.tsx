import {
  authSessionSchema,
  type AuthSession,
  type LoginRequest,
  type RegisterRequest,
} from '@pulsedesk/shared';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { createContext, use, type ReactNode } from 'react';
import { ApiError, apiRequest } from '@/lib/api-client';

export const SESSION_QUERY_KEY = ['auth', 'session'] as const;

/** The current session, or null when signed out (401). Network/API failures throw. */
export async function fetchSession(signal?: AbortSignal): Promise<AuthSession | null> {
  try {
    return await apiRequest('/api/v1/auth/session', {
      schema: authSessionSchema,
      ...(signal && { signal }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

/**
 * Restores the session from the HttpOnly cookie on load; the token itself is never visible
 * here. A 401 is an answer (signed out), not a failure. Transient failures — e.g. the API
 * waking from sleep — are retried with backoff by the QueryClient's default policy, and
 * every component that asks for the session shares the one in-flight request.
 */
export function useSessionQuery() {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: ({ signal }) => fetchSession(signal),
    staleTime: 5 * 60_000,
  });
}

/** Queries that don't depend on who is signed in (e.g. API liveness, an invitation link). */
const SESSION_INDEPENDENT = new Set<unknown>(['auth', 'api-health', 'invitation-preview']);

/** Everything cached for one user/organization must go when the session changes. */
export function replaceSession(queryClient: QueryClient, session: AuthSession | null) {
  queryClient.removeQueries({ predicate: (query) => !SESSION_INDEPENDENT.has(query.queryKey[0]) });
  queryClient.setQueryData(SESSION_QUERY_KEY, session);
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginRequest) =>
      apiRequest('/api/v1/auth/login', { method: 'POST', body: input, schema: authSessionSchema }),
    onSuccess: (session) => replaceSession(queryClient, session),
  });
}

export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RegisterRequest) =>
      apiRequest('/api/v1/auth/register', {
        method: 'POST',
        body: input,
        schema: authSessionSchema,
      }),
    onSuccess: (session) => replaceSession(queryClient, session),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest('/api/v1/auth/logout', { method: 'POST' }),
    // Forget the session locally even if the request failed; the server-side session
    // then simply expires. A retry is offered by signing in again.
    onSettled: () => replaceSession(queryClient, null),
  });
}

export function useSwitchOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (organizationId: string) =>
      apiRequest('/api/v1/auth/active-organization', {
        method: 'POST',
        body: { organizationId },
        schema: authSessionSchema,
      }),
    onSuccess: (session) => replaceSession(queryClient, session),
  });
}

/** A signed-in session with an active organization, provided by RequireAuth. */
export type ActiveSession = AuthSession & {
  activeOrganization: NonNullable<AuthSession['activeOrganization']>;
};

const SessionContext = createContext<ActiveSession | null>(null);

export function SessionProvider({
  session,
  children,
}: {
  session: ActiveSession;
  children: ReactNode;
}) {
  return <SessionContext value={session}>{children}</SessionContext>;
}

/** For components rendered inside the authenticated app shell. */
export function useActiveSession(): ActiveSession {
  const session = use(SessionContext);
  if (!session) throw new Error('useActiveSession() must be used inside RequireAuth');
  return session;
}
