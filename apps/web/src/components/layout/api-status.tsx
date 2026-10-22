import { Tooltip } from '@/components/ui/tooltip';
import { useApiHealth } from '@/lib/api-health';
import { isTransientApiError } from '@/lib/retry';
import { cn } from '@/lib/utils';

type Status = 'checking' | 'reconnecting' | 'online' | 'offline';

const LABELS: Record<Status, string> = {
  checking: 'Checking API…',
  reconnecting: 'Reconnecting…',
  online: 'API online',
  offline: 'API unreachable',
};

const DOT: Record<Status, string> = {
  checking: 'bg-subtle-foreground animate-shimmer',
  reconnecting: 'bg-warning animate-shimmer',
  online: 'bg-success',
  offline: 'bg-danger',
};

/** Live connection indicator backed by a real request to GET /health. */
export function ApiStatus({ collapsed = false }: { collapsed?: boolean }) {
  const health = useApiHealth();
  // A failed check is retried with backoff before it counts as an outage.
  const status: Status =
    health.isFetching && health.failureCount > 0
      ? 'reconnecting'
      : health.isPending
        ? 'checking'
        : health.isError
          ? 'offline'
          : 'online';
  const detail =
    status === 'online'
      ? `Version ${health.data?.version ?? ''} · up ${formatUptime(health.data?.uptimeSeconds ?? 0)}`
      : status === 'offline'
        ? import.meta.env.DEV
          ? 'Start it with pnpm dev:api'
          : isTransientApiError(health.error)
            ? 'The API stopped responding. It is re-checked every 30 seconds'
            : // e.g. a frontend-only preview deployment, where no API is connected yet.
              'No PulseDesk API responded at /health on this deployment'
        : status === 'reconnecting'
          ? 'The API may be starting up; retrying'
          : 'Contacting /health';

  return (
    <Tooltip content={`${LABELS[status]} — ${detail}`} side="right">
      <div
        role="status"
        aria-live="polite"
        className={cn(
          'flex items-center gap-2 rounded-md text-xs text-muted-foreground',
          collapsed ? 'size-9 justify-center' : 'h-8 px-2',
        )}
      >
        <span className="relative flex size-2 shrink-0">
          {status === 'online' && (
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-40 motion-reduce:hidden" />
          )}
          <span className={cn('relative inline-flex size-2 rounded-full', DOT[status])} />
        </span>
        <span className={cn(collapsed && 'sr-only')}>{LABELS[status]}</span>
        <span className="sr-only">. {detail}</span>
      </div>
    </Tooltip>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
