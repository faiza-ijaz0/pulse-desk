import { motion } from 'framer-motion';
import { Building2, ShieldCheck, Timer, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { BrandMark, BrandWordmark } from '@/components/layout/brand';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/misc';
import { useApiHealth } from '@/lib/api-health';
import { isTransientApiError } from '@/lib/retry';

const HIGHLIGHTS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Building2,
    title: 'Your own organization',
    body: 'Every workspace is isolated: data never crosses between organizations.',
  },
  {
    icon: ShieldCheck,
    title: 'Secure by default',
    body: 'Server-side sessions in HttpOnly cookies and Argon2id password hashing.',
  },
  {
    icon: Timer,
    title: 'Built for SLAs',
    body: 'Tickets, conversations and response targets arrive in the next phases.',
  },
];

/**
 * Tells the visitor up front when the API isn't answering: still waking up (retrying),
 * not responding after retries, or not attached at all (e.g. the frontend-only preview).
 */
function ApiUnavailableNotice() {
  const health = useApiHealth();
  if (health.isPending && health.failureCount > 0) {
    return (
      <Alert tone="info" title="Connecting to PulseDesk…" className="mb-6">
        The server may be starting up after a period of inactivity. This can take up to a minute.
      </Alert>
    );
  }
  if (!health.isError) return null;
  if (isTransientApiError(health.error)) {
    return (
      <Alert
        tone="warning"
        title="PulseDesk isn’t responding"
        className="mb-6"
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void health.refetch()}
            loading={health.isFetching}
          >
            Try again
          </Button>
        }
      >
        {import.meta.env.DEV
          ? 'Start it with pnpm dev:api, then try again.'
          : 'We couldn’t reach the server for a while. Check your connection, then try again.'}
      </Alert>
    );
  }
  return (
    <Alert tone="warning" title="The PulseDesk API is unreachable" className="mb-6">
      {import.meta.env.DEV
        ? 'Start it with pnpm dev:api, then try again.'
        : 'This deployment has no PulseDesk API connected yet, so signing in isn’t possible here.'}
    </Alert>
  );
}

export function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
      <main id="main" className="flex flex-col px-4 py-8 sm:px-8">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <BrandWordmark />
        </div>
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
          className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10"
        >
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1.5 mb-8 text-sm text-muted-foreground">{description}</p>
          <ApiUnavailableNotice />
          {children}
          <p className="mt-8 text-center text-sm text-muted-foreground">{footer}</p>
        </motion.div>
      </main>

      <aside
        aria-label="About PulseDesk"
        className="relative hidden overflow-hidden border-l border-border bg-surface-sunken lg:flex lg:flex-col lg:justify-center lg:px-14"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-40 -right-40 size-[28rem] rounded-full bg-accent/10 blur-3xl"
        />
        <div className="relative max-w-md">
          <p className="text-sm font-medium text-accent-subtle-foreground">PulseDesk</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-balance">
            Calm, fast customer support for growing teams.
          </h2>
          <ul className="mt-10 grid gap-6">
            {HIGHLIGHTS.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-accent-subtle-foreground shadow-xs">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <span>
                  <span className="block text-sm font-medium">{title}</span>
                  <span className="mt-0.5 block text-sm text-muted-foreground">{body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
