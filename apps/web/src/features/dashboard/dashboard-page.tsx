import { motion, type Variants } from 'framer-motion';
import { ArrowRight, Inbox, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/misc';
import { useActiveSession } from '@/features/auth/session';
import { AtRiskCard, RecentTicketsCard, StatCard, WorkloadCard } from './dashboard-widgets';
import {
  SAMPLE_AT_RISK,
  SAMPLE_STATS,
  SAMPLE_TICKETS,
  SAMPLE_VOLUME,
  SAMPLE_WORKLOAD,
} from './sample-data';
import { VolumeChart } from './volume-chart';

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

/**
 * The top of the dashboard: who and where you are, and shortcuts into the parts of PulseDesk
 * that work with real data. The metrics below it are a labelled preview.
 */
function Hero() {
  const { user, activeOrganization } = useActiveSession();
  const firstName = user.name.split(/\s+/)[0] ?? user.name;
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
            <Badge tone="accent">Sample data</Badge>
          </div>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            {activeOrganization.name} · Last 7 days · Sample data. Your tickets, customers and SLA
            states are live in the inbox.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
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

export function DashboardPage() {
  const welcome = welcomeFrom(useLocation().state);
  return (
    <>
      <Hero />

      {welcome && (
        <Alert tone="success" title={`${welcome} is ready`} className="mb-4">
          Your account and organization were created, and you’re signed in as its owner.
        </Alert>
      )}

      <Alert tone="info" title="This dashboard is a design preview" className="mb-6">
        Every number on this page is static sample data, not your organization’s activity. Tickets,
        customers and SLA states elsewhere in PulseDesk are real; live analytics replace this
        preview in Phase 6.
      </Alert>

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="grid gap-4 lg:gap-5"
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:gap-5 xl:grid-cols-4">
          {SAMPLE_STATS.map((stat) => (
            <Reveal key={stat.id}>
              <StatCard stat={stat} />
            </Reveal>
          ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-3 lg:gap-5">
          <Reveal className="lg:col-span-2 [&>section]:h-full">
            <VolumeChart data={SAMPLE_VOLUME} />
          </Reveal>
          <Reveal className="[&>section]:h-full">
            <AtRiskCard tickets={SAMPLE_AT_RISK} />
          </Reveal>
        </div>

        <div className="grid gap-4 lg:grid-cols-3 lg:gap-5">
          <Reveal className="min-w-0 lg:col-span-2">
            <RecentTicketsCard tickets={SAMPLE_TICKETS} />
          </Reveal>
          <Reveal className="[&>section]:h-full">
            <WorkloadCard agents={SAMPLE_WORKLOAD} />
          </Reveal>
        </div>
      </motion.div>
    </>
  );
}
