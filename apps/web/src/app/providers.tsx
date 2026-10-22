import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'framer-motion';
import { useState, type ReactNode } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DEFAULT_RETRY_POLICY, transientRetryOptions, type RetryPolicy } from '@/lib/retry';
import { ThemeProvider } from '@/lib/theme';

/**
 * Queries retry transient failures (cold starts, gateway errors) with backoff; mutations
 * never retry automatically — the user decides whether to submit again.
 */
export function createQueryClient(retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY) {
  return new QueryClient({
    defaultOptions: {
      queries: { refetchOnWindowFocus: false, ...transientRetryOptions(retryPolicy) },
      mutations: { retry: false },
    },
  });
}

export function AppProviders({
  children,
  queryClient,
}: {
  children: ReactNode;
  queryClient?: QueryClient;
}) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>
        {/* "user": Framer Motion disables transform/layout animation when the OS asks for reduced motion. */}
        <MotionConfig reducedMotion="user">
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            {children}
          </TooltipProvider>
        </MotionConfig>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
