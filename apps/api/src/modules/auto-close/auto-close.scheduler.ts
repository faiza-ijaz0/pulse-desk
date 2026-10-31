import type { Env } from '../../config/env.ts';
import {
  createPeriodicJob,
  jobIntervalMs,
  type PeriodicJob,
  type PeriodicRunOptions,
} from '../../lib/periodic-job.ts';
import type { Logger } from '../../lib/logger.ts';
import type { AutoCloseResult } from './auto-close.service.ts';

/**
 * How often this process auto-closes, or null when it must not: always off under
 * NODE_ENV=test (tests drive the sweep directly), and off when
 * AUTO_CLOSE_SWEEP_INTERVAL_SECONDS is 0.
 */
export function autoCloseIntervalMs(
  env: Pick<Env, 'NODE_ENV' | 'AUTO_CLOSE_SWEEP_INTERVAL_SECONDS'>,
): number | null {
  return jobIntervalMs(env.NODE_ENV, env.AUTO_CLOSE_SWEEP_INTERVAL_SECONDS);
}

/** The auto-close sweep on a timer (lib/periodic-job.ts: no overlap, graceful stop). */
export function createAutoCloseScheduler({
  intervalMs,
  sweep,
  logger,
}: {
  intervalMs: number;
  sweep: (options: PeriodicRunOptions) => Promise<AutoCloseResult>;
  logger: Logger;
}): PeriodicJob {
  return createPeriodicJob({
    label: 'Auto-close sweep',
    intervalMs,
    run: sweep,
    logger,
    summarize: (result) => ({
      fields: {
        checked: result.checked,
        closed: result.closed,
        skipped: result.skipped,
        unchanged: result.unchanged,
        failed: result.failed,
        truncated: result.truncated,
        stopped: result.stopped,
        durationMs: result.durationMs,
      },
      notable: result.closed + result.failed > 0 || result.truncated,
    }),
  });
}
