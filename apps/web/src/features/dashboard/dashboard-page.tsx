import { motion, type Variants } from 'framer-motion';
import { ArrowRight, Inbox, RotateCw, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { EmptyState, ErrorState } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/misc';
import { describeAuthError } from '@/features/auth/form-helpers';
import { SESSION_QUERY_KEY, useActiveSession } from '@/features/auth/session';
import { ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format-time';
import { useDashboardSummary } from './api';
import {
  DashboardSkeleton,
  MetricCards,
  MetricDefinitions,
  SlaHealthCard,
  StatusBreakdownCard,
  WorkloadCard,
} from './dashboard-widgets';

type SummaryQuery = ReturnType<typeof useDashboardSummary>;

const container: Variants = { show: { transition: { staggerChildren: 0.04 } } };
const item: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
};

function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={item} className={className}>
      {children}
    </motion.div>
  );
}

/** Set by the sign-up page on the first visit after an organization is created. */
function welcomeFrom(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null || !('welcome' in state)) return undefined;
  return typeof state.welcome === 'string' ? state.welcome : undefined;
}

/** Who and where you are, what the figures cover, when they were read, and a manual refresh. */
function Hero({ query }: { query: SummaryQuery }) {
  const { user, activeOrganization } = useActiveSession();
  const firstName = user.name.split(/\s+/)[0] ?? user.name;
  const summary = query.data;
  const coverage =
    summary === undefined
      ? 'Loading live metrics…'
      : summary.scope === 'own'
        ? 'Tickets assigned to you'
        : 'All tickets in this organization';
  const refreshing = query.isFetching && summary !== undefined;

  return (
    <section
      aria-labelledby="dashboard-title"
      className="relative mb-6 overflow-hidden rounded-2xl border border-accent/15 bg-brand-gradient-soft p-6 shadow-[var(--highlight),var(--elevation-sm)] md:p-8"
    >
      {/* Soft color blooms (decorative). */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-20 -right-10 size-72 rounded-full bg-magenta/15 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-24 left-1/3 size-72 rounded-full bg-info/15 blur-3xl"
      />
      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-accent-subtle-foreground">
            Welcome back, {firstName}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
            <h1 id="dashboard-title" className="text-3xl font-semibold tracking-tight">
              Support overview
            </h1>
            {summary && <Badge tone="success">Live</Badge>}
          </div>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            {activeOrganization.name} · {coverage}
            {summary && <> · Updated {formatDateTime(summary.generatedAt)}</>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {summary && (
            <Button
              variant="secondary"
              onClick={() => void query.refetch()}
              loading={refreshing}
              aria-label={refreshing ? 'Refreshing metrics' : 'Refresh metrics'}
            >
              {!refreshing && <RotateCw aria-hidden="true" />}
              Refresh
            </Button>
          )}
          <Button asChild>
            <Link to="/tickets">
              <Inbox aria-hidden="true" />
              Open the inbox
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild variant="secondary">
            <Link to="/customers">
              <Users aria-hidden="true" />
              Customers
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

function FailedState({ query }: { query: SummaryQuery }) {
  const queryClient = useQueryClient();
  const { error } = query;
  if (error instanceof ApiError && error.status === 401) {
    // Re-reading the session returns "signed out", and RequireAuth sends the user to sign in.
    return (
      <ErrorState
        title="Your session has ended"
        description="Sign in again to see your dashboard."
        retryLabel="Sign in again"
        onRetry={() => void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })}
      />
    );
  }
  if (error instanceof ApiError && error.status === 403) {
    return (
      <ErrorState
        title="Dashboard unavailable"
        description="Your role in this organization doesn’t include dashboard metrics."
      />
    );
  }
  return (
    <ErrorState
      title="We couldn’t load the dashboard"
      description={describeAuthError(error)}
      onRetry={() => void query.refetch()}
      retrying={query.isFetching}
    />
  );
}

function DashboardBody({ query }: { query: SummaryQuery }) {
  // Never render numbers before real ones arrive: no zeros while loading.
  if (query.isPending) return <DashboardSkeleton />;
  if (query.data === undefined) return <FailedState query={query} />;

  const summary = query.data;
  const { byStatus } = summary.tickets;
  const total =
    byStatus.OPEN + byStatus.PENDING + byStatus.ON_HOLD + byStatus.SOLVED + byStatus.CLOSED;

  return (
    <>
      {query.isError && (
        <Alert tone="warning" title="Couldn’t refresh the metrics" className="mb-4">
          Showing the figures from {formatDateTime(summary.generatedAt)}. They update again
          automatically, or use Refresh.
        </Alert>
      )}
      {total === 0 ? (
        <EmptyState
          icon={Inbox}
          title={summary.scope === 'own' ? 'No tickets assigned to you yet' : 'No tickets yet'}
          description={
            summary.scope === 'own'
              ? 'When a ticket is assigned to you, its status, SLA state and response times appear here.'
              : 'Create the first ticket to see your queue, SLA health and response times here.'
          }
        >
          <Button asChild>
            <Link to="/tickets">
              <Inbox aria-hidden="true" />
              Go to the inbox
            </Link>
          </Button>
        </EmptyState>
      ) : (
        <motion.div
          variants={container}
          initial="hidden"
          animate="show"
          className="grid gap-4 lg:gap-5"
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:gap-5 xl:grid-cols-4">
            <MetricCards tickets={summary.tickets} responseTimes={summary.responseTimes} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3 lg:gap-5">
            <Reveal className="lg:col-span-2">
              <SlaHealthCard
                sla={summary.sla}
                active={summary.tickets.active}
                generatedAt={summary.generatedAt}
              />
            </Reveal>
            <Reveal>
              <StatusBreakdownCard byStatus={byStatus} />
            </Reveal>
          </div>
          <Reveal>
            <WorkloadCard
              agents={summary.agents}
              unassigned={summary.tickets.unassigned}
              scope={summary.scope}
            />
          </Reveal>
          <Reveal>
            <MetricDefinitions scope={summary.scope} />
          </Reveal>
        </motion.div>
      )}
    </>
  );
}

export function DashboardPage() {
  const welcome = welcomeFrom(useLocation().state);
  const { activeOrganization } = useActiveSession();
  const query = useDashboardSummary(activeOrganization.id);
  return (
    <>
      <Hero query={query} />
      {welcome && (
        <Alert tone="success" title={`${welcome} is ready`} className="mb-4">
          Your account and organization were created, and you’re signed in as its owner.
        </Alert>
      )}
      <DashboardBody query={query} />
    </>
  );
}
