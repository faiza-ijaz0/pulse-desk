import {
  ACTIVE_TICKET_STATUSES,
  DASHBOARD_WINDOW_DAYS,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type DashboardSummary,
  type SlaStatus,
} from '@pulsedesk/shared';
import {
  ArrowRight,
  CircleCheckBig,
  Hourglass,
  Inbox,
  MessageSquareReply,
  Timer,
  UserRoundX,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, Skeleton } from '@/components/ui/misc';
import { filtersToSearchParams } from '@/features/tickets/filters';
import { SLA_STATUS_LABELS, SlaBadge, TicketPriorityLabel } from '@/features/tickets/ticket-badges';
import { formatRelative } from '@/lib/format-time';
import { cn } from '@/lib/utils';
import { formatDuration, percentOf } from './format';

type Tickets = DashboardSummary['tickets'];
type Sla = DashboardSummary['sla'];
type ResponseTimes = DashboardSummary['responseTimes'];
type Agent = DashboardSummary['agents'][number];

/* ─── Metric cards ──────────────────────────────────────────────────────────── */

const LOOKS = {
  active: { icon: Inbox, chip: 'bg-accent-subtle text-accent-subtle-foreground' },
  awaiting: { icon: MessageSquareReply, chip: 'bg-warning-subtle text-warning-foreground' },
  firstResponse: { icon: Timer, chip: 'bg-info-subtle text-info-foreground' },
  resolution: { icon: CircleCheckBig, chip: 'bg-magenta-subtle text-magenta-foreground' },
} satisfies Record<string, { icon: LucideIcon; chip: string }>;

function MetricCard({
  look,
  label,
  value,
  detail,
}: {
  look: keyof typeof LOOKS;
  label: string;
  value: ReactNode;
  detail: ReactNode;
}) {
  const { icon: Icon, chip } = LOOKS[look];
  return (
    <Card className="flex h-full flex-col p-5">
      <div className="flex items-center gap-2.5">
        <span className={cn('flex size-8 items-center justify-center rounded-lg', chip)}>
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <h2 className="text-sm font-medium text-muted-foreground">{label}</h2>
      </div>
      <p className="mt-4 text-[2rem] leading-none font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      <p className="mt-3 text-xs text-muted-foreground">{detail}</p>
    </Card>
  );
}

function AverageValue({ average }: { average: ResponseTimes['firstResponse'] }) {
  if (average.averageSeconds === null) {
    return (
      <>
        <span aria-hidden="true" className="text-muted-foreground">
          —
        </span>
        <span className="sr-only">No data</span>
      </>
    );
  }
  return <>{formatDuration(average.averageSeconds)}</>;
}

function averageDetail(
  average: ResponseTimes['firstResponse'],
  [one, many]: readonly [string, string],
): string {
  if (average.count === 0) return `No ${many} in the last ${DASHBOARD_WINDOW_DAYS} days`;
  const noun = average.count === 1 ? one : many;
  return `Average of ${average.count} ${noun} · last ${DASHBOARD_WINDOW_DAYS} days`;
}

export function MetricCards({
  tickets,
  responseTimes,
}: {
  tickets: Tickets;
  responseTimes: ResponseTimes;
}) {
  const { byStatus } = tickets;
  return (
    <>
      <MetricCard
        look="active"
        label="Active tickets"
        value={tickets.active}
        detail={`${byStatus.OPEN} open · ${byStatus.PENDING} pending · ${byStatus.ON_HOLD} on hold`}
      />
      <MetricCard
        look="awaiting"
        label="Awaiting first response"
        value={tickets.awaitingFirstResponse}
        detail="Active tickets without a public reply yet"
      />
      <MetricCard
        look="firstResponse"
        label="Avg. first response"
        value={<AverageValue average={responseTimes.firstResponse} />}
        detail={averageDetail(responseTimes.firstResponse, ['first reply', 'first replies'])}
      />
      <MetricCard
        look="resolution"
        label="Avg. resolution time"
        value={<AverageValue average={responseTimes.resolution} />}
        detail={averageDetail(responseTimes.resolution, ['solved ticket', 'solved tickets'])}
      />
    </>
  );
}

/* ─── SLA health ────────────────────────────────────────────────────────────── */

// Most urgent first. Color is never the only cue: every segment has a labelled legend row.
const SLA_ORDER = [
  'resolution_breached',
  'first_response_breached',
  'at_risk',
  'on_track',
  'met',
  'none',
] as const satisfies readonly SlaStatus[];

const SLA_SEGMENT: Record<SlaStatus, string> = {
  resolution_breached: 'bg-danger',
  first_response_breached: 'bg-danger/60',
  at_risk: 'bg-warning',
  on_track: 'bg-info',
  met: 'bg-success',
  none: 'bg-border-strong',
};

function dueText(item: Sla['attention'][number], now: Date): string {
  const target = item.target === 'firstResponse' ? 'First reply' : 'Resolution';
  if (!item.dueAt) return target;
  const when = formatRelative(item.dueAt, now);
  return item.status === 'at_risk' ? `${target} due ${when}` : `${target} was due ${when}`;
}

export function SlaHealthCard({
  sla,
  active,
  generatedAt,
}: {
  sla: Sla;
  active: number;
  generatedAt: string;
}) {
  const now = new Date(generatedAt);
  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <div>
          <CardTitle id="sla-health-title">SLA health</CardTitle>
          <CardDescription>
            Active tickets by SLA state, as the inbox badges show them
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-6 pt-3">
        {active === 0 ? (
          <p className="text-sm text-muted-foreground">
            No active tickets, so nothing is on an SLA clock right now.
          </p>
        ) : (
          <div>
            <div
              aria-hidden="true"
              className="flex h-3 w-full overflow-hidden rounded-full bg-surface-sunken"
            >
              {SLA_ORDER.filter((status) => sla.active[status] > 0).map((status) => (
                <div
                  key={status}
                  className={SLA_SEGMENT[status]}
                  style={{ width: `${(sla.active[status] / active) * 100}%` }}
                />
              ))}
            </div>
            <dl
              aria-labelledby="sla-health-title"
              className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2"
            >
              {SLA_ORDER.map((status) => (
                <div key={status} className="flex items-center justify-between gap-3 text-sm">
                  <dt className="flex items-center gap-2 text-muted-foreground">
                    <span
                      aria-hidden="true"
                      className={cn('size-2.5 rounded-full', SLA_SEGMENT[status])}
                    />
                    {SLA_STATUS_LABELS[status]}
                  </dt>
                  <dd className="font-medium tabular-nums">
                    {sla.active[status]}
                    {/* Spoken as "3 tickets, 30%", not "330%". */}
                    <span className="sr-only">
                      {sla.active[status] === 1 ? ' ticket, ' : ' tickets, '}
                    </span>
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                      {percentOf(sla.active[status], active)}%
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        <div>
          <h3 className="text-sm font-semibold">Needs attention</h3>
          {sla.attention.length === 0 ? (
            <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
              <CircleCheckBig className="size-4 text-success-foreground" aria-hidden="true" />
              Nothing is at risk or breached.
            </p>
          ) : (
            <ul className="mt-2 grid gap-2">
              {sla.attention.map((item) => (
                <li key={item.number}>
                  <Link
                    to={`/tickets/${item.number}`}
                    className="block rounded-lg border border-border bg-surface-sunken/50 px-3 py-2.5 transition-colors hover:border-accent/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 text-sm leading-snug font-medium">
                        <span className="mr-1.5 font-mono text-xs text-muted-foreground">
                          #{item.number}
                        </span>{' '}
                        {item.subject}
                      </p>
                      <SlaBadge status={item.status} />
                    </div>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Hourglass className="size-3" aria-hidden="true" />
                        {dueText(item, now)}
                      </span>
                      <TicketPriorityLabel priority={item.priority} />
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Status breakdown ──────────────────────────────────────────────────────── */

const STATUS_BAR: Record<(typeof TICKET_STATUSES)[number], string> = {
  OPEN: 'bg-chart-1',
  PENDING: 'bg-warning',
  ON_HOLD: 'bg-chart-3',
  SOLVED: 'bg-success',
  CLOSED: 'bg-border-strong',
};

export function StatusBreakdownCard({ byStatus }: { byStatus: Tickets['byStatus'] }) {
  const total = TICKET_STATUSES.reduce((sum, status) => sum + byStatus[status], 0);
  const max = Math.max(...TICKET_STATUSES.map((status) => byStatus[status]), 0);
  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <div>
          <CardTitle id="status-breakdown-title">Tickets by status</CardTitle>
          <CardDescription>
            All {total} {total === 1 ? 'ticket' : 'tickets'}, by current status
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="pt-3">
        <ul aria-labelledby="status-breakdown-title" className="grid gap-3">
          {TICKET_STATUSES.map((status) => (
            <li key={status}>
              <p className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">
                  {TICKET_STATUS_LABELS[status]}
                  {ACTIVE_TICKET_STATUSES.includes(status) && (
                    <span className="sr-only"> (active)</span>
                  )}
                  <span className="sr-only">:</span>
                </span>{' '}
                <span className="font-medium tabular-nums">{byStatus[status]}</span>
              </p>
              <div
                aria-hidden="true"
                className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken"
              >
                <div
                  className={cn('h-full rounded-full', STATUS_BAR[status])}
                  style={{ width: `${max > 0 ? (byStatus[status] / max) * 100 : 0}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ─── Workload by agent ─────────────────────────────────────────────────────── */

/**
 * The inbox filtered to one assignee's active tickets, so the list matches the count shown
 * here (a plain `?assignee=` link would also list their solved and closed tickets).
 */
function activeTicketsLink(assignee: string): string {
  const params = filtersToSearchParams({
    status: [...ACTIVE_TICKET_STATUSES],
    assignee,
    sort: 'newest',
  });
  return `/tickets?${params.toString()}`;
}

const ROLE_LABELS: Record<Agent['role'], string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  AGENT: 'Agent',
};

function AgentRow({ agent, max }: { agent: Agent; max: number }) {
  return (
    <li>
      <Link
        to={activeTicketsLink(agent.userId)}
        className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-sunken/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Avatar name={agent.name} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="truncate text-sm font-medium">
              {agent.name}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                {ROLE_LABELS[agent.role]}
              </span>
            </p>
            <p className="shrink-0 text-sm font-semibold tabular-nums">
              {agent.active}
              <span className="sr-only"> active</span>
            </p>
          </div>
          <div
            aria-hidden="true"
            className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken"
          >
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${max > 0 ? (agent.active / max) * 100 : 0}%` }}
            />
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {agent.open} open · {agent.pending} pending · {agent.onHold} on hold
            {agent.atRisk > 0 && (
              <span className="text-warning-foreground"> · {agent.atRisk} at risk</span>
            )}
            {agent.breached > 0 && (
              <span className="text-danger-foreground"> · {agent.breached} breached</span>
            )}
          </p>
        </div>
      </Link>
    </li>
  );
}

export function WorkloadCard({
  agents,
  unassigned,
  scope,
}: {
  agents: Agent[];
  unassigned: number | null;
  scope: DashboardSummary['scope'];
}) {
  const max = Math.max(...agents.map((a) => a.active), 0);
  const assigned = agents.reduce((sum, a) => sum + a.active, 0);
  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <div>
          <CardTitle>{scope === 'own' ? 'Your workload' : 'Workload by agent'}</CardTitle>
          <CardDescription>Active tickets per assignee, busiest first</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3 pt-2">
        {assigned === 0 ? (
          <p className="rounded-lg border border-dashed border-border-strong bg-surface-sunken/50 px-4 py-6 text-center text-sm text-muted-foreground">
            {scope === 'own'
              ? 'No active tickets are assigned to you.'
              : 'No active tickets are assigned to anyone yet.'}
          </p>
        ) : (
          <ul className="-mx-2 grid gap-0.5">
            {agents.map((agent) => (
              <AgentRow key={agent.userId} agent={agent} max={max} />
            ))}
          </ul>
        )}
        {unassigned !== null && (
          <Link
            to={activeTicketsLink('unassigned')}
            className="mt-auto flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5 text-sm transition-colors hover:border-accent/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="inline-flex items-center gap-2 text-muted-foreground">
              <UserRoundX className="size-4" aria-hidden="true" />
              Unassigned active tickets
            </span>
            <span className="inline-flex items-center gap-1.5 font-semibold tabular-nums">
              {unassigned}
              <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
            </span>
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Definitions ───────────────────────────────────────────────────────────── */

export function MetricDefinitions({ scope }: { scope: DashboardSummary['scope'] }) {
  return (
    <details className="group rounded-xl border border-border bg-surface px-5 py-4 text-sm shadow-[var(--highlight),var(--elevation-sm)]">
      <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        How these numbers are calculated
      </summary>
      <dl className="mt-4 grid gap-3 text-muted-foreground md:grid-cols-2">
        <div>
          <dt className="font-medium text-foreground">Scope</dt>
          <dd>
            {scope === 'own'
              ? 'Tickets currently assigned to you. Owners and admins see the whole organization.'
              : 'Every ticket in this organization.'}{' '}
            Figures are read live from the database and refresh every minute.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Active tickets</dt>
          <dd>Open, Pending and On hold: the statuses whose resolution clock is still running.</dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Awaiting first response</dt>
          <dd>Active tickets with no public agent reply yet. Internal notes don’t count.</dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">SLA health</dt>
          <dd>
            Each active ticket’s current SLA state, computed exactly like its inbox badge. A ticket
            is at risk when 25% or less of its target window is left.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Avg. first response</dt>
          <dd>
            Time from ticket creation to the first public agent reply, for first replies sent in the
            last {DASHBOARD_WINDOW_DAYS} days. Calendar time, not business hours.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Avg. resolution time</dt>
          <dd>
            Time from creation to solved, for tickets solved in the last {DASHBOARD_WINDOW_DAYS}{' '}
            days and still solved or closed. A reopened ticket counts from its latest solve.
          </dd>
        </div>
      </dl>
    </details>
  );
}

/* ─── Loading ───────────────────────────────────────────────────────────────── */

export function DashboardSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-4 lg:gap-5">
      <p className="sr-only" role="status">
        Loading dashboard metrics…
      </p>
      <div className="grid gap-4 sm:grid-cols-2 lg:gap-5 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="p-5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="mt-5 h-8 w-1/3" />
            <Skeleton className="mt-4 h-3 w-2/3" />
          </Card>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3 lg:gap-5">
        <Skeleton className="h-72 rounded-xl lg:col-span-2" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    </div>
  );
}
