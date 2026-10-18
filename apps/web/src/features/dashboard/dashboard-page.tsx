import { motion, type Variants } from 'framer-motion';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { PageHeader } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/misc';
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

export function DashboardPage() {
  const welcome = welcomeFrom(useLocation().state);
  return (
    <>
      <PageHeader
        title="Support overview"
        meta={<Badge tone="accent">Sample data</Badge>}
        description="Last 7 days · Sample data"
      />

      {welcome && (
        <Alert tone="success" title={`${welcome} is ready`} className="mb-4">
          Your account and organization were created, and you’re signed in as its owner.
        </Alert>
      )}

      <Alert tone="info" title="This dashboard is a design preview" className="mb-6">
        Every number on this page is static sample data, not your organization’s activity. Live
        metrics replace it when the ticket inbox (Phase 4) and analytics (Phase 6) are built.
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
