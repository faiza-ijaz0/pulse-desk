import { healthResponseSchema, type HealthResponse } from '@pulsedesk/shared';
import { useQuery } from '@tanstack/react-query';

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch('/health', {
    signal: signal ?? null,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`API health check failed with HTTP ${response.status}`);
  // Validate against the shared contract so a misconfigured proxy (e.g. one that returns
  // the SPA's index.html) is reported as unreachable rather than "online".
  return healthResponseSchema.parse(await response.json());
}

/** Real liveness of the PulseDesk API, re-checked every 30 seconds. */
export function useApiHealth() {
  return useQuery({
    queryKey: ['api-health'],
    queryFn: ({ signal }) => fetchHealth(signal),
    refetchInterval: 30_000,
    retry: 1,
    staleTime: 10_000,
  });
}
