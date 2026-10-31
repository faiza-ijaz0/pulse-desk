import type { Env } from '../../config/env.ts';
import { createPeriodicJob, jobIntervalMs, type PeriodicJob } from '../../lib/periodic-job.ts';
import type { Logger } from '../../lib/logger.ts';
import type { SlaSweepResult, SweepOptions } from './sla-sweep.service.ts';

/**
 * How often this process sweeps, or null when it must not: always off under NODE_ENV=test
 * (tests drive the sweep directly), and off when SLA_SWEEP_INTERVAL_SECONDS is 0.
 */
export function slaSweepIntervalMs(
  env: Pick<Env, 'NODE_ENV' | 'SLA_SWEEP_INTERVAL_SECONDS'>,
): number | null {
  return jobIntervalMs(env.NODE_ENV, env.SLA_SWEEP_INTERVAL_SECONDS);
}

export type SlaSweepScheduler = PeriodicJob;

/** The SLA breach sweep on a timer (lib/periodic-job.ts: no overlap, graceful stop). */
export function createSlaSweepScheduler({
  intervalMs,
  sweep,
  logger,
}: {
  intervalMs: number;
  sweep: (options: SweepOptions) => Promise<SlaSweepResult>;
  logger: Logger;
}): SlaSweepScheduler {
  return createPeriodicJob({
    label: 'SLA sweep',
    intervalMs,
    run: sweep,
    logger,
    summarize: (result) => ({
      fields: {
        checked: result.checked,
        firstResponseBreaches: result.recorded.firstResponse,
        resolutionBreaches: result.recorded.resolution,
        skipped: result.skipped,
        failed: result.failed,
        truncated: result.truncated,
        stopped: result.stopped,
        durationMs: result.durationMs,
      },
      notable:
        result.recorded.firstResponse + result.recorded.resolution + result.failed > 0 ||
        result.truncated,
    }),
  });
}
