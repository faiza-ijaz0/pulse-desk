import { analyticsReportResponseSchema } from '@pulsedesk/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api-client';
import { analyticsPath, type AnalyticsRange } from './range';

// Dropped with every other session-scoped key when the session or organization changes
// (features/auth/session); the organization ID in the key is a second safeguard.
export const analyticsKeys = {
  report: (organizationId: string, range: AnalyticsRange, timeZone: string) =>
    ['analytics', 'report', organizationId, range.from, range.to, timeZone] as const,
};

/**
 * Historical analytics for the active organization (`GET /api/v1/analytics`), validated
 * against the shared contract. While another range loads, the previous report stays on
 * screen (marked as updating) instead of flashing back to a skeleton.
 */
export function useAnalyticsReport(
  organizationId: string,
  range: AnalyticsRange,
  timeZone: string,
) {
  return useQuery({
    queryKey: analyticsKeys.report(organizationId, range, timeZone),
    queryFn: ({ signal }) =>
      apiRequest(analyticsPath(range, timeZone), { schema: analyticsReportResponseSchema, signal }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}
