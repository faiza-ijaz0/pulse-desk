import { ArrowDownRight, ArrowUpRight, Clock, UserRoundX } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar } from '@/components/ui/misc';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TicketPriorityLabel, TicketStatusBadge } from '@/features/tickets/ticket-badges';
import { cn } from '@/lib/utils';
import type { AgentLoad, AtRiskTicket, SampleTicket, StatTile } from './sample-data';

function Sparkline({ points }: { points: number[] }) {
  const width = 88;
  const height = 32;
  const pad = 5; // room for the 8px end-dot and its ring
  const min = Math.min(...points);
  const range = Math.max(...points) - min || 1;
  const coords = points.map((p, i) => [
    pad + (i / (points.length - 1)) * (width - pad * 2),
    pad + (1 - (p - min) / range) * (height - pad * 2),
  ]);
  const last = coords.at(-1) ?? [0, 0];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      className="shrink-0 overflow-visible"
    >
      <polyline
        points={coords.map(([x, y]) => `${x},${y}`).join(' ')}
        fill="none"
        className="stroke-border-strong"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx={last[0]}
        cy={last[1]}
        r="4"
        className="fill-accent stroke-surface"
        strokeWidth="2"
      />
    </svg>
  );
}

export function StatCard({ stat }: { stat: StatTile }) {
  const { delta } = stat;
  const DeltaIcon = delta.direction === 'up' ? ArrowUpRight : ArrowDownRight;
  return (
    <Card className="p-5">
      <h2 className="text-sm font-medium text-muted-foreground">{stat.label}</h2>
      <div className="mt-2 flex items-end justify-between gap-3">
        <p className="text-3xl font-semibold tracking-tight">{stat.value}</p>
        <Sparkline points={stat.trend} />
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span
          className={cn(
            'inline-flex items-center gap-0.5 font-medium',
            delta.good ? 'text-success-foreground' : 'text-danger-foreground',
          )}
        >
          <DeltaIcon className="size-3.5" aria-hidden="true" />
          {delta.text}
          <span className="sr-only">{delta.good ? '(improvement)' : '(worse)'}</span>
        </span>
        {stat.comparison}
      </p>
    </Card>
  );
}

function dueTone(minutes: number) {
  if (minutes <= 30) return 'danger' as const;
  if (minutes <= 60) return 'warning' as const;
  return 'neutral' as const;
}

function formatMinutes(minutes: number): string {
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function AtRiskCard({ tickets }: { tickets: AtRiskTicket[] }) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div>
          <CardTitle>SLA at risk</CardTitle>
          <CardDescription>Breaching within the next 2 hours</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex-1 pt-3">
        <ul className="grid gap-2">
          {tickets.map((t) => (
            <li
              key={t.number}
              className="rounded-md border border-border bg-surface-sunken/50 px-3 py-2.5"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 text-sm leading-snug font-medium">
                  <span className="mr-1.5 font-mono text-xs text-muted-foreground">
                    #{t.number}
                  </span>
                  {t.subject}
                </p>
                <Badge tone={dueTone(t.dueInMinutes)} className="mt-px">
                  <Clock className="size-3" aria-hidden="true" />
                  {formatMinutes(t.dueInMinutes)}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{t.target} target</p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function Assignee({ name }: { name: string | null }) {
  if (!name) {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <span className="flex size-6 items-center justify-center rounded-full border border-dashed border-border-strong">
          <UserRoundX className="size-3" aria-hidden="true" />
        </span>
        Unassigned
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <Avatar name={name} size="sm" />
      <span className="truncate">{name}</span>
    </span>
  );
}

export function RecentTicketsCard({ tickets }: { tickets: SampleTicket[] }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div>
          <CardTitle id="recent-tickets-title">Recent tickets</CardTitle>
          <CardDescription>Latest activity across all queues</CardDescription>
        </div>
      </CardHeader>

      {/* Tablet & desktop: table. */}
      <div className="hidden border-t border-border md:block">
        <Table aria-labelledby="recent-tickets-title">
          <TableHeader className="bg-surface-sunken/60">
            <TableRow className="hover:bg-transparent">
              <TableHead>Ticket</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Assignee</TableHead>
              <TableHead className="text-right">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tickets.map((t) => (
              <TableRow key={t.number}>
                <TableCell className="max-w-80">
                  <p className="truncate font-medium">{t.subject}</p>
                  <p className="text-xs text-muted-foreground">
                    <span className="font-mono">#{t.number}</span> · {t.customer}
                  </p>
                </TableCell>
                <TableCell>
                  <TicketStatusBadge status={t.status} />
                </TableCell>
                <TableCell>
                  <TicketPriorityLabel priority={t.priority} />
                </TableCell>
                <TableCell>
                  <Assignee name={t.assignee} />
                </TableCell>
                <TableCell className="text-right text-xs whitespace-nowrap text-muted-foreground">
                  {t.updated}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile: stacked list — a table would force horizontal scrolling. */}
      <ul
        className="divide-y divide-border border-t border-border md:hidden"
        aria-labelledby="recent-tickets-title"
      >
        {tickets.map((t) => (
          <li key={t.number} className="grid gap-2 px-5 py-3.5">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm leading-snug font-medium">{t.subject}</p>
              <span className="shrink-0 text-xs text-muted-foreground">{t.updated}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              <span className="font-mono">#{t.number}</span> · {t.customer}
            </p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <TicketStatusBadge status={t.status} />
              <TicketPriorityLabel priority={t.priority} />
              <Assignee name={t.assignee} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function WorkloadCard({ agents }: { agents: AgentLoad[] }) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div>
          <CardTitle>Team workload</CardTitle>
          <CardDescription>Open tickets against each agent’s capacity</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid flex-1 content-start gap-4 pt-4">
        {agents.map((agent) => {
          const ratio = agent.open / agent.capacity;
          const high = ratio >= 0.9;
          return (
            <div key={agent.name} className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2.5">
                  <Avatar name={agent.name} size="sm" />
                  <span className="grid min-w-0 leading-tight">
                    <span className="truncate text-sm font-medium">{agent.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{agent.team}</span>
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  <span className="font-medium text-foreground">{agent.open}</span> /{' '}
                  {agent.capacity}
                  {high && (
                    <span className="ml-1.5 font-medium text-warning-foreground">
                      Near capacity
                    </span>
                  )}
                </span>
              </div>
              <div
                role="meter"
                aria-label={`${agent.name} workload`}
                aria-valuemin={0}
                aria-valuemax={agent.capacity}
                aria-valuenow={agent.open}
                aria-valuetext={`${agent.open} of ${agent.capacity} tickets`}
                className={cn(
                  'h-1.5 overflow-hidden rounded-full',
                  high ? 'bg-warning-subtle' : 'bg-accent-subtle',
                )}
              >
                <div
                  className={cn(
                    'h-full rounded-full transition-[width] duration-500 ease-out-quint',
                    high ? 'bg-warning' : 'bg-accent',
                  )}
                  style={{ width: `${Math.min(100, ratio * 100)}%` }}
                />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
