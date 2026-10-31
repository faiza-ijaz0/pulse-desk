import { Prisma } from '@pulsedesk/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger.ts';
import {
  createSlaSweepScheduler,
  slaSweepIntervalMs,
} from '../src/modules/sla/sla-sweep.scheduler.ts';
import type { SlaSweepResult, SweepOptions } from '../src/modules/sla/sla-sweep.service.ts';
import { captureLogs } from './helpers.ts';

const INTERVAL = 60_000;

function result(overrides: Partial<SlaSweepResult> = {}): SlaSweepResult {
  return {
    checked: 0,
    recorded: { firstResponse: 0, resolution: 0 },
    skipped: 0,
    failed: 0,
    truncated: false,
    stopped: false,
    durationMs: 1,
    ...overrides,
  };
}

/** A sweep the test finishes by hand, to observe overlap and shutdown. */
function controllableSweep() {
  const runs: { options: SweepOptions; finish: (r?: SlaSweepResult) => void }[] = [];
  const sweep = vi.fn(
    (options: SweepOptions) =>
      new Promise<SlaSweepResult>((resolve) => {
        runs.push({ options, finish: (r = result()) => resolve(r) });
      }),
  );
  return { sweep, runs };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('slaSweepIntervalMs', () => {
  it('is off in tests and when the interval is 0, otherwise the interval in ms', () => {
    expect(slaSweepIntervalMs({ NODE_ENV: 'test', SLA_SWEEP_INTERVAL_SECONDS: 60 })).toBeNull();
    expect(
      slaSweepIntervalMs({ NODE_ENV: 'production', SLA_SWEEP_INTERVAL_SECONDS: 0 }),
    ).toBeNull();
    expect(slaSweepIntervalMs({ NODE_ENV: 'development', SLA_SWEEP_INTERVAL_SECONDS: 60 })).toBe(
      60_000,
    );
    expect(slaSweepIntervalMs({ NODE_ENV: 'production', SLA_SWEEP_INTERVAL_SECONDS: 5 })).toBe(
      5_000,
    );
  });
});

describe('SLA sweep scheduler', () => {
  const logger = createLogger({ level: 'silent', version: 'test' });

  it('does nothing until started, then runs once per interval', async () => {
    const { sweep, runs } = controllableSweep();
    const scheduler = createSlaSweepScheduler({ intervalMs: INTERVAL, sweep, logger });

    await vi.advanceTimersByTimeAsync(5 * INTERVAL);
    expect(sweep).not.toHaveBeenCalled();

    scheduler.start();
    scheduler.start(); // idempotent
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledOnce();

    runs[0]!.finish();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(sweep).toHaveBeenCalledTimes(2);
    runs[1]!.finish();
    await scheduler.stop();
  });

  it('never overlaps runs: the next is scheduled only after the previous one finishes', async () => {
    const { sweep, runs } = controllableSweep();
    const scheduler = createSlaSweepScheduler({ intervalMs: INTERVAL, sweep, logger });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(INTERVAL);
    await vi.advanceTimersByTimeAsync(10 * INTERVAL); // the first run is still going
    expect(sweep).toHaveBeenCalledOnce();

    runs[0]!.finish();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(sweep).toHaveBeenCalledTimes(2);
    runs[1]!.finish();
    await scheduler.stop();
  });

  it('on stop, cancels the next run and waits for the running one, which is told to stop', async () => {
    const { sweep, runs } = controllableSweep();
    const scheduler = createSlaSweepScheduler({ intervalMs: INTERVAL, sweep, logger });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(runs[0]!.options.shouldStop?.()).toBe(false);

    let stopped = false;
    const stopping = scheduler.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(runs[0]!.options.shouldStop?.()).toBe(true);
    expect(stopped).toBe(false); // still waiting for the run in progress

    runs[0]!.finish(result({ stopped: true }));
    await stopping;
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(sweep).toHaveBeenCalledOnce();

    scheduler.start(); // a stopped scheduler stays stopped
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(sweep).toHaveBeenCalledOnce();
  });

  it('stops immediately when no run is in progress', async () => {
    const { sweep } = controllableSweep();
    const scheduler = createSlaSweepScheduler({ intervalMs: INTERVAL, sweep, logger });
    scheduler.start();
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(sweep).not.toHaveBeenCalled();
  });

  it('logs counts and duration, and keeps running after a failed run', async () => {
    const logs = captureLogs();
    const logLevel = createLogger({ level: 'info', version: 'test', destination: logs.stream });
    const sweep = vi
      .fn<(options: SweepOptions) => Promise<SlaSweepResult>>()
      .mockResolvedValueOnce(
        result({ checked: 3, recorded: { firstResponse: 2, resolution: 1 }, durationMs: 42 }),
      )
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('down', { code: 'P1001', clientVersion: 'test' }),
      )
      .mockResolvedValue(result());
    const scheduler = createSlaSweepScheduler({ intervalMs: INTERVAL, sweep, logger: logLevel });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(4 * INTERVAL);
    await scheduler.stop();
    expect(sweep).toHaveBeenCalledTimes(4);

    expect(logs.lines.find((l) => l.msg === 'SLA sweep finished')).toMatchObject({
      level: 'info',
      checked: 3,
      firstResponseBreaches: 2,
      resolutionBreaches: 1,
      durationMs: 42,
    });
    expect(logs.lines.find((l) => l.msg === 'SLA sweep failed')).toMatchObject({
      level: 'error',
      errorCode: 'UNHANDLED',
    });
    expect(
      logs.lines.find((l) => l.msg === 'SLA sweep skipped: database unavailable'),
    ).toMatchObject({ level: 'warn', errorCode: 'P1001' });
    // A quiet run (nothing recorded) isn't logged at info.
    expect(logs.lines.filter((l) => l.msg === 'SLA sweep finished')).toHaveLength(1);
  });
});
