import { databaseUnavailableCode, prismaErrorCode } from '@pulsedesk/db';
import type { Logger } from './logger.ts';

export type PeriodicRunOptions = {
  /** Checked by the job between units of work: a shutdown ends the run early. */
  shouldStop: () => boolean;
};

export type PeriodicJob = {
  /** Schedules the first run one interval from now; later calls do nothing. */
  start(): void;
  /** Cancels the next run and waits for one in progress, which stops at its next check. */
  stop(): Promise<void>;
};

/**
 * How often a background job runs in this process, or null when it must not: always off
 * under NODE_ENV=test (tests drive jobs directly), and off when the interval is 0.
 */
export function jobIntervalMs(nodeEnv: string, intervalSeconds: number): number | null {
  if (nodeEnv === 'test' || intervalSeconds === 0) return null;
  return intervalSeconds * 1000;
}

/**
 * Runs `run` every `intervalMs` inside this API process. The next run is scheduled only
 * after the previous one finishes, so runs of one job never overlap here; correctness across
 * processes is each job's own business (row locks), but deployments assume a single API
 * instance (docs/deployment.md). A failed run is logged and the schedule continues.
 *
 * `summarize` turns a result into aggregate log fields (never customer content) and says
 * whether the run is worth an info line; quiet runs log at debug.
 */
export function createPeriodicJob<Result>({
  label,
  intervalMs,
  run,
  summarize,
  logger,
}: {
  /** e.g. "SLA sweep": log lines read "<label> finished" / "failed" / "skipped: …". */
  label: string;
  intervalMs: number;
  run: (options: PeriodicRunOptions) => Promise<Result>;
  summarize: (result: Result) => { fields: Record<string, unknown>; notable: boolean };
  logger: Logger;
}): PeriodicJob {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let started = false;
  let stopping = false;

  async function runOnce(): Promise<void> {
    try {
      const { fields, notable } = summarize(await run({ shouldStop: () => stopping }));
      if (notable) logger.info(fields, `${label} finished`);
      else logger.debug(fields, `${label} finished`);
    } catch (error) {
      const unavailable = databaseUnavailableCode(error);
      if (unavailable !== undefined) {
        logger.warn({ errorCode: unavailable }, `${label} skipped: database unavailable`);
      } else {
        logger.error(
          { err: error, errorCode: prismaErrorCode(error) ?? 'UNHANDLED' },
          `${label} failed`,
        );
      }
    }
  }

  function scheduleNext(): void {
    if (stopping) return;
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = runOnce().finally(() => {
        inFlight = undefined;
        scheduleNext();
      });
    }, intervalMs);
    // The HTTP server keeps the process alive; a pending job alone never should.
    timer.unref();
  }

  return {
    start() {
      if (started || stopping) return;
      started = true;
      scheduleNext();
    },
    async stop() {
      stopping = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await inFlight;
    },
  };
}
