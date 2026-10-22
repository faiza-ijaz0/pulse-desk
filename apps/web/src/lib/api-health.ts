import { healthResponseSchema, type HealthResponse } from '@pulsedesk/shared';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from './api-client';

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  // Validated against the shared contract, so a misconfigured proxy (e.g. one that returns
  // the SPA's index.html) is reported as unreachable rather than "online".
  return apiRequest('/health', { schema: healthResponseSchema, ...(signal && { signal }) });
}

/**
 * Real liveness of the PulseDesk API, re-checked every 30 seconds. Transient failures are
 * retried with backoff (QueryClient defaults), so a sleeping API reads as "connecting", not
 * "unreachable"; `failureCount > 0` while pending tells the UI that is happening.
 */
export function useApiHealth() {
  return useQuery({
    queryKey: ['api-health'],
    queryFn: ({ signal }) => fetchHealth(signal),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}
