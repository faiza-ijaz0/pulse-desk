import { dashboardSummaryResponseSchema } from '@pulsedesk/shared';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';

/** How often an open dashboard re-reads its metrics in the background. */
export const DASHBOARD_REFRESH_MS = 60_000;

// Dropped with every other session-scoped key when the session or organization changes
// (features/auth/session); the organization ID in the key is a second safeguard.
export const dashboardKeys = {
  summary: (organizationId: string) => ['dashboard', 'summary', organizationId] as const,
};

/**
 * Live metrics for the active organization (`GET /api/v1/dashboard`), validated against the
 * shared contract. Kept on screen while a background refresh runs.
 */
export function useDashboardSummary(organizationId: string) {
  return useQuery({
    queryKey: dashboardKeys.summary(organizationId),
    queryFn: ({ signal }) =>
      apiRequest('/api/v1/dashboard', { schema: dashboardSummaryResponseSchema, signal }),
    staleTime: DASHBOARD_REFRESH_MS / 2,
    refetchInterval: DASHBOARD_REFRESH_MS,
  });
}
