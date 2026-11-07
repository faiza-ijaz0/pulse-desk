import {
  ANALYTICS_EARLIEST_DATE,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  calendarDateIn,
  type AnalyticsReport,
  type AnalyticsSlaOutcomes,
} from '@pulsedesk/shared';
import { useQueryClient } from '@tanstack/react-query';
import { BarChart3, CalendarRange, CircleCheck, CircleX } from 'lucide-react';
import { useId, useMemo, useState, type ReactNode, type SyntheticEvent } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState, ErrorState } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Alert, Skeleton } from '@/components/ui/misc';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { describeAuthError } from '@/features/auth/form-helpers';
import { SESSION_QUERY_KEY, useActiveSession } from '@/features/auth/session';
import { formatDuration, percentOf } from '@/features/dashboard/format';
import { PRIORITY_LABELS } from '@/features/tickets/ticket-badges';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { ColumnChart, formatRange } from './analytics-charts';
import { useAnalyticsReport } from './api';
import {
  RANGE_PRESETS,
  browserTimeZone,
  presetOf,
  presetRange,
  rangeFromSearchParams,
  rangeProblem,
  type AnalyticsRange,
} from './range';

type ReportQuery = ReturnType<typeof useAnalyticsReport>;

/* ─── Range filter ──────────────────────────────────────────────────────────── */

function RangeFilter({
  range,
  today,
  onChange,
}: {
  range: AnalyticsRange;
  today: string;
  onChange: (range: AnalyticsRange) => void;
}) {
  const active = presetOf(range, today);
  const [custom, setCustom] = useState(active === null);
  const [draft, setDraft] = useState(range);
  const [problem, setProblem] = useState<string | null>(null);
  const fromId = useId();
  const toId = useId();
  const problemId = useId();

  function apply(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = rangeProblem(draft, today);
    setProblem(message);
    if (message === null) onChange(draft);
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        role="group"
        aria-label="Date range"
        className="inline-flex flex-wrap gap-1 self-start rounded-lg border border-border bg-surface-sunken p-0.5"
      >
        {RANGE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            aria-pressed={!custom && active === preset.id}
            onClick={() => {
              setCustom(false);
              setProblem(null);
              const next = presetRange(preset.days, today);
              setDraft(next);
              onChange(next);
            }}
            className={cn(
              'h-8 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              !custom && active === preset.id
                ? 'bg-surface text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={custom}
          aria-expanded={custom}
          onClick={() => setCustom((open) => !open)}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            custom
              ? 'bg-surface text-foreground shadow-xs'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <CalendarRange className="size-4" aria-hidden="true" />
          Custom
        </button>
      </div>
      {custom && (
        <form
          onSubmit={apply}
          aria-label="Custom date range"
          className="flex flex-wrap items-end gap-3"
          noValidate
        >
          <div className="grid gap-1.5">
            <label htmlFor={fromId} className="text-sm font-medium">
              From
            </label>
            <Input
              id={fromId}
              type="date"
              value={draft.from}
              min={ANALYTICS_EARLIEST_DATE}
              max={today}
              aria-describedby={problem ? problemId : undefined}
              aria-invalid={problem ? true : undefined}
              onChange={(event) => setDraft({ ...draft, from: event.target.value })}
              className="w-40"
            />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor={toId} className="text-sm font-medium">
              To
            </label>
            <Input
              id={toId}
              type="date"
              value={draft.to}
              min={ANALYTICS_EARLIEST_DATE}
              max={today}
              aria-describedby={problem ? problemId : undefined}
              aria-invalid={problem ? true : undefined}
              onChange={(event) => setDraft({ ...draft, to: event.target.value })}
              className="w-40"
            />
          </div>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          {problem && (
            <p id={problemId} role="alert" className="basis-full text-sm text-danger-foreground">
              {problem}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

/* ─── Summary tiles ─────────────────────────────────────────────────────────── */

function Tile({ label, value, detail }: { label: string; value: ReactNode; detail: ReactNode }) {
  return (
    <Card className="flex h-full flex-col p-5">
      <h2 className="text-sm font-medium text-muted-foreground">{label}</h2>
      <p className="mt-3 text-[2rem] leading-none font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      <p className="mt-3 text-xs text-muted-foreground">{detail}</p>
    </Card>
  );
}

function NoData() {
  return (
    <>
      <span aria-hidden="true" className="text-muted-foreground">
        —
      </span>
      <span className="sr-only">No data</span>
    </>
  );
}

function durationValue(seconds: number | null) {
  return seconds === null ? <NoData /> : formatDuration(seconds);
}

function durationDetail(
  stats: AnalyticsReport['responseTimes']['firstResponse'],
  noun: [string, string],
) {
  if (stats.count === 0) return `No ${noun[1]} in this period`;
  const average =
    stats.averageSeconds === null
      ? ''
      : ` · average ${formatDuration(stats.averageSeconds).replace(/^Under/, 'under')}`;
  return `Median of ${stats.count} ${stats.count === 1 ? noun[0] : noun[1]}${average}`;
}

function SummaryTiles({ report }: { report: AnalyticsReport }) {
  const { totals, responseTimes } = report;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:gap-5 xl:grid-cols-4">
      <Tile label="Tickets created" value={totals.created} detail="New tickets in this period" />
      <Tile
        label="Tickets solved"
        value={totals.solved}
        detail={`${totals.reopened} ${totals.reopened === 1 ? 'reopen' : 'reopens'} in this period`}
      />
      <Tile
        label="Median first response"
        value={durationValue(responseTimes.firstResponse.medianSeconds)}
        detail={durationDetail(responseTimes.firstResponse, ['first reply', 'first replies'])}
      />
      <Tile
        label="Median resolution time"
        value={durationValue(responseTimes.resolution.medianSeconds)}
        detail={durationDetail(responseTimes.resolution, ['solved ticket', 'solved tickets'])}
      />
    </div>
  );
}

/* ─── SLA performance ───────────────────────────────────────────────────────── */

function compliance(outcomes: AnalyticsSlaOutcomes): number | null {
  const decided = outcomes.met + outcomes.breached;
  return decided === 0 ? null : percentOf(outcomes.met, decided);
}

/** Met and breached as one bar; each part labelled in text beside it (never color alone). */
function OutcomeBar({ outcomes }: { outcomes: AnalyticsSlaOutcomes }) {
  const decided = outcomes.met + outcomes.breached;
  if (decided === 0) {
    return <div aria-hidden="true" className="h-2 rounded-full bg-surface-sunken" />;
  }
  return (
    <div aria-hidden="true" className="flex h-2 gap-0.5 overflow-hidden rounded-full">
      {outcomes.met > 0 && (
        <div className="bg-success" style={{ width: `${(outcomes.met / decided) * 100}%` }} />
      )}
      {outcomes.breached > 0 && (
        <div className="bg-danger" style={{ width: `${(outcomes.breached / decided) * 100}%` }} />
      )}
    </div>
  );
}

function OutcomeCounts({ outcomes }: { outcomes: AnalyticsSlaOutcomes }) {
  return (
    <span className="inline-flex flex-wrap gap-x-3 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <CircleCheck className="size-3.5 text-success-foreground" aria-hidden="true" />
        {outcomes.met} met
      </span>
      <span className="inline-flex items-center gap-1">
        <CircleX className="size-3.5 text-danger-foreground" aria-hidden="true" />
        {outcomes.breached} breached
      </span>
    </span>
  );
}

function SlaCard({ sla }: { sla: AnalyticsReport['sla'] }) {
  const targets = [
    { key: 'firstResponse', label: 'First response' },
    { key: 'resolution', label: 'Resolution' },
  ] as const;
  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <div>
          <CardTitle>SLA performance</CardTitle>
          <CardDescription>Targets met or breached in this period</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6 pt-3">
        <dl className="grid gap-4 sm:grid-cols-2">
          {targets.map(({ key, label }) => {
            const rate = compliance(sla[key]);
            return (
              <div key={key} className="grid gap-2 rounded-lg border border-border p-4">
                <dt className="text-sm text-muted-foreground">{label} compliance</dt>
                <dd className="grid gap-2">
                  <span className="text-2xl font-semibold tabular-nums">
                    {rate === null ? <NoData /> : `${rate}%`}
                  </span>
                  <OutcomeBar outcomes={sla[key]} />
                  <OutcomeCounts outcomes={sla[key]} />
                </dd>
              </div>
            );
          })}
        </dl>
        <Table aria-label="SLA outcomes by priority">
          <TableHeader>
            <TableRow>
              <TableHead>Priority</TableHead>
              <TableHead className="text-right">First response</TableHead>
              <TableHead className="text-right">Resolution</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...sla.byPriority].reverse().map((row) => (
              <TableRow key={row.priority}>
                <TableCell className="h-10">{PRIORITY_LABELS[row.priority]}</TableCell>
                {targets.map(({ key }) => {
                  const rate = compliance(row[key]);
                  return (
                    <TableCell key={key} className="h-10 text-right tabular-nums">
                      {rate === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <>
                          {rate}%
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            ({row[key].met}/{row[key].met + row[key].breached})
                          </span>
                        </>
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/* ─── Created tickets by current status ─────────────────────────────────────── */

const STATUS_BAR: Record<(typeof TICKET_STATUSES)[number], string> = {
  OPEN: 'bg-chart-1',
  PENDING: 'bg-warning',
  ON_HOLD: 'bg-chart-3',
  SOLVED: 'bg-success',
  CLOSED: 'bg-border-strong',
};

function StatusCard({
  byStatus,
  total,
}: {
  byStatus: AnalyticsReport['createdByCurrentStatus'];
  total: number;
}) {
  const titleId = useId();
  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <div>
          <CardTitle id={titleId}>Where new tickets are now</CardTitle>
          <CardDescription>
            The {total} {total === 1 ? 'ticket' : 'tickets'} created in this period, by current
            status
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="pt-3">
        <ul aria-labelledby={titleId} className="grid gap-3">
          {TICKET_STATUSES.map((status) => (
            <li key={status}>
              <p className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">
                  {TICKET_STATUS_LABELS[status]}
                  <span className="sr-only">:</span>
                </span>{' '}
                <span className="font-medium tabular-nums">
                  {byStatus[status]}
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    {percentOf(byStatus[status], total)}%
                  </span>
                </span>
              </p>
              <div
                aria-hidden="true"
                className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken"
              >
                <div
                  className={cn('h-full rounded-full', STATUS_BAR[status])}
                  style={{ width: `${percentOf(byStatus[status], total)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ─── Agent performance ─────────────────────────────────────────────────────── */

const ROLE_LABELS = { OWNER: 'Owner', ADMIN: 'Admin', AGENT: 'Agent' } as const;

function AgentsCard({ report }: { report: AnalyticsReport }) {
  const titleId = useId();
  const own = report.scope === 'own';
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle id={titleId}>{own ? 'Your activity' : 'Agent performance'}</CardTitle>
          <CardDescription>
            What each member did in this period, on any ticket, most solves first
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="pt-2">
        <Table aria-labelledby={titleId}>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead className="text-right">Solved</TableHead>
              <TableHead className="text-right">Public replies</TableHead>
              <TableHead className="text-right">First replies</TableHead>
              <TableHead className="text-right">Avg. first reply time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.agents.map((agent) => (
              <TableRow key={agent.userId}>
                <TableCell className="h-11">
                  <span className="font-medium">{agent.name}</span>
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {ROLE_LABELS[agent.role]}
                  </span>
                </TableCell>
                <TableCell className="h-11 text-right tabular-nums">{agent.solved}</TableCell>
                <TableCell className="h-11 text-right tabular-nums">
                  {agent.publicReplies}
                </TableCell>
                <TableCell className="h-11 text-right tabular-nums">
                  {agent.firstResponses.count}
                </TableCell>
                <TableCell className="h-11 text-right whitespace-nowrap tabular-nums">
                  {durationValue(agent.firstResponses.averageSeconds)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/* ─── Definitions ───────────────────────────────────────────────────────────── */

function Definitions({ scope }: { scope: AnalyticsReport['scope'] }) {
  const items: [string, string][] = [
    [
      'Scope',
      scope === 'own'
        ? 'Ticket figures cover the tickets assigned to you now; your activity covers everything you did, on any ticket. Owners and admins see the whole organization.'
        : 'Every ticket in this organization, and every member’s activity.',
    ],
    [
      'Days',
      'Cut at midnight in your time zone. Ranges longer than 92 days are shown in 7-day periods.',
    ],
    [
      'Solved and reopened',
      'Status changes recorded on the ticket timeline: a ticket solved, reopened and solved again counts as two solves and one reopen.',
    ],
    [
      'First response time',
      'Ticket creation to the first public agent reply, counted on the day of the reply. Internal notes don’t count. Calendar time, not business hours.',
    ],
    [
      'Resolution time',
      'Creation to the latest solve, for tickets that are still solved or closed, counted on the day of that solve.',
    ],
    [
      'SLA compliance',
      'Targets met ÷ targets met or breached, on the day each was decided: a reply or solve before the due date, or a breach. Targets still running aren’t counted. Priority is the ticket’s current one.',
    ],
    [
      'Where new tickets are now',
      'Tickets created in the period by their status today, not their status at the time.',
    ],
  ];
  return (
    <details className="group rounded-xl border border-border bg-surface px-5 py-4 text-sm shadow-[var(--highlight),var(--elevation-sm)]">
      <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        How these numbers are calculated
      </summary>
      <dl className="mt-4 grid gap-3 text-muted-foreground md:grid-cols-2">
        {items.map(([term, definition]) => (
          <div key={term}>
            <dt className="font-medium text-foreground">{term}</dt>
            <dd>{definition}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/* ─── States ────────────────────────────────────────────────────────────────── */

function AnalyticsSkeleton() {
  return (
    <div aria-busy="true" className="grid grid-cols-1 gap-4 lg:gap-5">
      <p className="sr-only" role="status">
        Loading analytics…
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:gap-5 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="p-5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="mt-5 h-8 w-1/3" />
            <Skeleton className="mt-4 h-3 w-2/3" />
          </Card>
        ))}
      </div>
      <Skeleton className="h-80 rounded-xl" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-5">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}

function FailedState({ query }: { query: ReportQuery }) {
  const queryClient = useQueryClient();
  const { error } = query;
  if (error instanceof ApiError && error.status === 401) {
    return (
      <ErrorState
        title="Your session has ended"
        description="Sign in again to see analytics."
        retryLabel="Sign in again"
        onRetry={() => void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })}
      />
    );
  }
  if (error instanceof ApiError && error.status === 403) {
    return (
      <ErrorState
        title="Analytics unavailable"
        description="Your role in this organization doesn’t include analytics."
      />
    );
  }
  return (
    <ErrorState
      title="We couldn’t load analytics"
      description={describeAuthError(error)}
      onRetry={() => void query.refetch()}
      retrying={query.isFetching}
    />
  );
}

/** True when nothing at all happened in the range (no chart would have a single mark). */
function isQuiet(report: AnalyticsReport): boolean {
  const { totals, responseTimes, sla } = report;
  return (
    totals.created + totals.solved + totals.reopened === 0 &&
    responseTimes.firstResponse.count + responseTimes.resolution.count === 0 &&
    sla.firstResponse.met + sla.firstResponse.breached === 0 &&
    sla.resolution.met + sla.resolution.breached === 0 &&
    report.agents.every((a) => a.solved + a.publicReplies === 0)
  );
}

function Report({ report }: { report: AnalyticsReport }) {
  const { buckets } = report;
  const days = report.range.granularity === 'day' ? 'per day' : 'per 7 days';
  const period = formatRange(report.range.from, report.range.to);

  if (isQuiet(report)) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No activity in this period"
        description={
          report.scope === 'own'
            ? 'Nothing was created on tickets assigned to you, and you didn’t reply or solve anything, between these dates. Try a longer range.'
            : 'No tickets were created, answered or solved between these dates. Try a longer range.'
        }
      />
    );
  }

  return (
    // `grid-cols-1` is minmax(0, 1fr): a wide table scrolls inside its card instead of
    // stretching the column (and the page) past the screen.
    <div className="grid grid-cols-1 gap-4 lg:gap-5">
      <SummaryTiles report={report} />
      <ColumnChart
        title="Created vs solved"
        description={`Tickets created and solve actions, ${days}`}
        kind="count"
        buckets={buckets}
        series={[
          {
            key: 'created',
            label: 'Created',
            swatch: 'bg-chart-1',
            values: buckets.map((b) => b.created),
          },
          {
            key: 'solved',
            label: 'Solved',
            swatch: 'bg-chart-2',
            values: buckets.map((b) => b.solved),
          },
        ]}
        summary={`${report.totals.created} tickets created and ${report.totals.solved} solved, ${period}.`}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-5">
        <ColumnChart
          title="First response time"
          description={`Average wait for the first public reply, ${days}`}
          kind="duration"
          buckets={buckets}
          series={[
            {
              key: 'firstResponse',
              label: 'Average',
              swatch: 'bg-chart-1',
              values: buckets.map((b) => b.firstResponse.averageSeconds),
            },
          ]}
          emptyValue="No first replies"
          summary={`Average first response time ${days}, ${period}.`}
        />
        <ColumnChart
          title="Resolution time"
          description={`Average time from creation to solved, ${days}`}
          kind="duration"
          buckets={buckets}
          series={[
            {
              key: 'resolution',
              label: 'Average',
              swatch: 'bg-chart-2',
              values: buckets.map((b) => b.resolution.averageSeconds),
            },
          ]}
          emptyValue="No solves"
          summary={`Average resolution time ${days}, ${period}.`}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-5">
        <div className="min-w-0 lg:col-span-2">
          <SlaCard sla={report.sla} />
        </div>
        <StatusCard byStatus={report.createdByCurrentStatus} total={report.totals.created} />
      </div>
      <AgentsCard report={report} />
      <Definitions scope={report.scope} />
    </div>
  );
}

/* ─── Page ──────────────────────────────────────────────────────────────────── */

export function AnalyticsPage() {
  const { activeOrganization } = useActiveSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const timeZone = useMemo(() => browserTimeZone(), []);
  const today = calendarDateIn(new Date(), timeZone);
  const range = rangeFromSearchParams(searchParams, today);
  const query = useAnalyticsReport(activeOrganization.id, range, timeZone);
  const report = query.data;
  const updating = query.isPlaceholderData || (query.isFetching && report !== undefined);

  return (
    <>
      <header className="mb-6 flex flex-col gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-3xl font-semibold tracking-tight">Analytics</h1>
            {report?.scope === 'own' && <Badge tone="neutral">Your tickets</Badge>}
          </div>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {activeOrganization.name} · {formatRange(range.from, range.to)} · days in {timeZone}
            {updating && (
              <span role="status" className="ml-2 text-accent-subtle-foreground">
                Updating…
              </span>
            )}
          </p>
        </div>
        <RangeFilter
          key={`${range.from}:${range.to}`}
          range={range}
          today={today}
          onChange={(next) => setSearchParams({ from: next.from, to: next.to })}
        />
      </header>

      {query.isPending ? (
        <AnalyticsSkeleton />
      ) : report === undefined ? (
        <FailedState query={query} />
      ) : (
        <>
          {query.isError && (
            <Alert tone="warning" title="Couldn’t refresh analytics" className="mb-4">
              Showing {formatRange(report.range.from, report.range.to)}.{' '}
              {describeAuthError(query.error)}
            </Alert>
          )}
          <div className={cn('transition-opacity', updating && 'opacity-60')}>
            <Report report={report} />
          </div>
        </>
      )}
    </>
  );
}
