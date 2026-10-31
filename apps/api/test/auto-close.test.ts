import { Prisma, type TicketStatus } from '@pulsedesk/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger.ts';
import type {
  AutoCloseCandidate,
  AutoCloseRepository,
} from '../src/modules/auto-close/auto-close.repository.ts';
import {
  autoCloseIntervalMs,
  createAutoCloseScheduler,
} from '../src/modules/auto-close/auto-close.scheduler.ts';
import {
  autoCloseDecision,
  autoCloseDueAt,
  createAutoCloseService,
  type AutoCloseResult,
} from '../src/modules/auto-close/auto-close.service.ts';
import { captureLogs } from './helpers.ts';

// The auto-close rules, batching and scheduler without a database: an in-memory repository
// with the real contract (candidates in solvedAt order after a cursor, a row lock per ticket,
// a close that is conditional on SOLVED). test/integration/auto-close.int.test.ts covers the
// SQL, locking, transactions and tenant scoping on PostgreSQL.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const T0 = new Date('2026-10-20T08:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * MINUTE);
const ON = { autoCloseEnabled: true, autoCloseAfterMinutes: 60 };
const silent = createLogger({ level: 'silent', version: 'test' });

describe('autoCloseDueAt / autoCloseDecision', () => {
  const solved = (
    overrides: Partial<{ status: TicketStatus; solvedAt: Date | null; updatedAt: Date }> = {},
  ) => ({
    status: 'SOLVED' as TicketStatus,
    solvedAt: at(0),
    closedAt: null,
    updatedAt: at(0),
    ...overrides,
  });

  it('is due the delay after the solve, inclusive at the exact deadline', () => {
    expect(autoCloseDueAt(solved(), 60)).toEqual(at(60));
    expect(autoCloseDecision({ ticket: solved(), settings: ON }, at(59))).toBe('not_due');
    expect(autoCloseDecision({ ticket: solved(), settings: ON }, at(60))).toBe('close');
  });

  it('waits a full delay after the last update when there was activity after solving', () => {
    const touched = solved({ updatedAt: at(45) });
    expect(autoCloseDueAt(touched, 60)).toEqual(at(105));
    expect(autoCloseDecision({ ticket: touched, settings: ON }, at(104))).toBe('not_due');
    expect(autoCloseDecision({ ticket: touched, settings: ON }, at(105))).toBe('close');
  });

  it('never closes when auto-close is off, or a ticket that is not solved', () => {
    expect(
      autoCloseDecision(
        { ticket: solved(), settings: { ...ON, autoCloseEnabled: false } },
        at(10 * DAY),
      ),
    ).toBe('disabled');
    for (const status of ['OPEN', 'PENDING', 'ON_HOLD', 'CLOSED'] as const) {
      expect(
        autoCloseDecision({ ticket: solved({ status }), settings: ON }, at(10 * DAY)),
        status,
      ).toBe('not_solved');
    }
    expect(
      autoCloseDecision({ ticket: solved({ solvedAt: null }), settings: ON }, at(10 * DAY)),
    ).toBe('not_solved');
  });

  it('uses the organization’s own delay', () => {
    const settings = { autoCloseEnabled: true, autoCloseAfterMinutes: 4 * 24 * 60 };
    expect(autoCloseDecision({ ticket: solved(), settings }, at(4 * 24 * 60 - 1))).toBe('not_due');
    expect(autoCloseDecision({ ticket: solved(), settings }, at(4 * 24 * 60))).toBe('close');
  });
});

type FakeTicket = {
  id: string;
  organizationId: string;
  status: TicketStatus;
  solvedAt: Date | null;
  closedAt: Date | null;
  updatedAt: Date;
};

let sequence = 0;
function ticket(overrides: Partial<FakeTicket> = {}): FakeTicket {
  sequence++;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    organizationId: 'org-a',
    status: 'SOLVED',
    solvedAt: at(0),
    closedAt: null,
    updatedAt: at(0),
    ...overrides,
  };
}

/** The repository contract, in memory. `beforeLock` simulates a write landing just before the lock. */
function fakeRepository(
  tickets: FakeTicket[],
  options: {
    settings?: Record<string, { autoCloseEnabled: boolean; autoCloseAfterMinutes: number }>;
    locked?: Set<string>;
    failOn?: Map<string, Error>;
    beforeLock?: (t: FakeTicket) => void;
  } = {},
) {
  const settingsFor = (org: string) => options.settings?.[org] ?? ON;
  const events: { ticketId: string; organizationId: string; data: object; at: Date }[] = [];
  const calls: (string | null)[] = [];
  const due = (t: FakeTicket) =>
    t.solvedAt &&
    Math.max(t.solvedAt.getTime(), t.updatedAt.getTime()) +
      settingsFor(t.organizationId).autoCloseAfterMinutes * MINUTE;

  const repository: AutoCloseRepository = {
    findCandidates(now, after, limit) {
      calls.push(after?.id ?? null);
      const ordered = tickets
        .filter(
          (t) =>
            t.status === 'SOLVED' &&
            settingsFor(t.organizationId).autoCloseEnabled &&
            (due(t) ?? Infinity) <= now.getTime(),
        )
        .sort((a, b) => a.solvedAt!.getTime() - b.solvedAt!.getTime() || a.id.localeCompare(b.id));
      const start = after ? ordered.findIndex((t) => t.id === after.id) + 1 : 0;
      return Promise.resolve(
        ordered.slice(start, start + limit).map((t): AutoCloseCandidate => ({
          id: t.id,
          organizationId: t.organizationId,
          solvedAt: t.solvedAt!.toISOString(),
        })),
      );
    },
    async withLockedTicket(candidate, fn) {
      const failure = options.failOn?.get(candidate.id);
      if (failure) throw failure;
      if (options.locked?.has(candidate.id)) return null;
      const t = tickets.find(
        (x) => x.id === candidate.id && x.organizationId === candidate.organizationId,
      );
      if (!t) return null;
      options.beforeLock?.(t);
      return fn({
        ticket: {
          status: t.status,
          solvedAt: t.solvedAt,
          closedAt: t.closedAt,
          updatedAt: t.updatedAt,
        },
        settings: settingsFor(t.organizationId),
        close(when) {
          if (t.status !== 'SOLVED') return Promise.resolve(false);
          Object.assign(t, { status: 'CLOSED', closedAt: when, updatedAt: when });
          events.push({
            ticketId: t.id,
            organizationId: t.organizationId,
            data: { from: 'SOLVED', to: 'CLOSED' },
            at: when,
          });
          return Promise.resolve(true);
        },
      });
    },
  };
  return { repository, events, calls };
}

const service = (
  repository: AutoCloseRepository,
  now: Date,
  extra: { batchSize?: number; maxBatches?: number } = {},
) =>
  createAutoCloseService({
    repository,
    clock: { now: () => now },
    logger: silent,
    batchSize: extra.batchSize ?? 100,
    ...(extra.maxBatches !== undefined && { maxBatches: extra.maxBatches }),
  });

describe('auto-close service', () => {
  it('closes due tickets once, with one SYSTEM event each, as of the run time', async () => {
    const due = ticket();
    const notYet = ticket({ solvedAt: at(30), updatedAt: at(30) });
    const open = ticket({ status: 'OPEN', solvedAt: null });
    const { repository, events } = fakeRepository([due, notYet, open]);

    const result = await service(repository, at(60)).sweep();
    expect(result).toMatchObject({ checked: 1, closed: 1, skipped: 0, unchanged: 0, failed: 0 });
    expect(due).toMatchObject({
      status: 'CLOSED',
      closedAt: at(60),
      updatedAt: at(60),
      solvedAt: at(0),
    });
    expect(notYet.status).toBe('SOLVED');
    expect(open.status).toBe('OPEN');
    expect(events).toEqual([
      {
        ticketId: due.id,
        organizationId: 'org-a',
        data: { from: 'SOLVED', to: 'CLOSED' },
        at: at(60),
      },
    ]);
  });

  it('is idempotent: another run, or a fresh service after a restart, closes nothing more', async () => {
    const { repository, events } = fakeRepository([ticket(), ticket()]);
    expect((await service(repository, at(60)).sweep()).closed).toBe(2);
    expect((await service(repository, at(60)).sweep()).closed).toBe(0);
    expect(events).toHaveLength(2);
  });

  it('respects a reopen or an update that lands before the lock (a stale decision never wins)', async () => {
    const reopened = ticket();
    const updated = ticket();
    const { repository, events } = fakeRepository([reopened, updated], {
      beforeLock: (t) => {
        if (t === reopened) Object.assign(t, { status: 'OPEN', solvedAt: null, updatedAt: at(59) });
        if (t === updated) t.updatedAt = at(59); // e.g. an agent's reply on the solved ticket
      },
    });
    const result = await service(repository, at(60)).sweep();
    expect(result).toMatchObject({ checked: 2, closed: 0, unchanged: 2 });
    expect(reopened.status).toBe('OPEN');
    expect(updated.status).toBe('SOLVED');
    expect(events).toEqual([]);
  });

  it('re-reads the settings: auto-close switched off in the meantime closes nothing', async () => {
    const t = ticket();
    const settings = { 'org-a': { ...ON } };
    const { repository } = fakeRepository([t], {
      settings,
      beforeLock: () => (settings['org-a'].autoCloseEnabled = false),
    });
    expect(await service(repository, at(60)).sweep()).toMatchObject({ closed: 0, unchanged: 1 });
    expect(t.status).toBe('SOLVED');
  });

  it('applies each organization’s own setting', async () => {
    const inA = ticket({ organizationId: 'org-a' });
    const inB = ticket({ organizationId: 'org-b' });
    const offInC = ticket({ organizationId: 'org-c' });
    const { repository, events } = fakeRepository([inA, inB, offInC], {
      settings: {
        'org-a': { autoCloseEnabled: true, autoCloseAfterMinutes: 60 },
        'org-b': { autoCloseEnabled: true, autoCloseAfterMinutes: 120 },
        'org-c': { autoCloseEnabled: false, autoCloseAfterMinutes: 1 },
      },
    });
    await service(repository, at(60)).sweep();
    expect([inA.status, inB.status, offInC.status]).toEqual(['CLOSED', 'SOLVED', 'SOLVED']);
    expect(events.map((e) => e.organizationId)).toEqual(['org-a']);
  });

  it('skips a ticket another transaction holds, and closes it on a later run', async () => {
    const t = ticket();
    const locked = new Set([t.id]);
    const { repository } = fakeRepository([t], { locked });
    expect(await service(repository, at(60)).sweep()).toMatchObject({
      checked: 1,
      skipped: 1,
      closed: 0,
    });
    locked.clear();
    expect((await service(repository, at(60)).sweep()).closed).toBe(1);
  });

  it('processes bounded batches in solvedAt order, continuing from a cursor', async () => {
    const tickets = Array.from({ length: 5 }, (_, i) =>
      ticket({ solvedAt: at(-10 + i), updatedAt: at(-10 + i) }),
    );
    const { repository, calls } = fakeRepository(tickets);
    const first = await service(repository, at(60), { batchSize: 2, maxBatches: 2 }).sweep();
    expect(first).toMatchObject({ checked: 4, closed: 4, truncated: true });
    expect(calls).toEqual([null, tickets[1]!.id]);
    expect(tickets.map((t) => t.status)).toEqual([
      'CLOSED',
      'CLOSED',
      'CLOSED',
      'CLOSED',
      'SOLVED',
    ]);
    expect(
      (await service(repository, at(60), { batchSize: 2, maxBatches: 2 }).sweep()).closed,
    ).toBe(1);
  });

  it('logs a failing ticket without its content and carries on', async () => {
    const broken = ticket({ solvedAt: at(-2) });
    const fine = ticket({ solvedAt: at(-1) });
    const { repository } = fakeRepository([broken, fine], {
      failOn: new Map([[broken.id, new Error('boom')]]),
    });
    const logs = captureLogs();
    const result = await createAutoCloseService({
      repository,
      clock: { now: () => at(60) },
      logger: createLogger({ level: 'info', version: 'test', destination: logs.stream }),
      batchSize: 100,
    }).sweep();
    expect(result).toMatchObject({ failed: 1, closed: 1 });
    expect(logs.lines.find((l) => l.msg === 'Auto-close could not process a ticket')).toMatchObject(
      {
        ticketId: broken.id,
        organizationId: 'org-a',
      },
    );
  });

  it('ends the run on a database outage', async () => {
    const outage = new Prisma.PrismaClientKnownRequestError('down', {
      code: 'P1001',
      clientVersion: 'test',
    });
    const t = ticket();
    const { repository } = fakeRepository([t], { failOn: new Map([[t.id, outage]]) });
    await expect(service(repository, at(60)).sweep()).rejects.toBe(outage);
  });

  it('stops between tickets when asked to (shutdown)', async () => {
    const tickets = [ticket({ solvedAt: at(-2) }), ticket({ solvedAt: at(-1) })];
    const { repository } = fakeRepository(tickets);
    let calls = 0;
    const result = await service(repository, at(60)).sweep({ shouldStop: () => calls++ >= 1 });
    expect(result).toMatchObject({ checked: 1, closed: 1, stopped: true });
    expect(tickets[1]!.status).toBe('SOLVED');
  });
});

describe('auto-close scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const result = (overrides: Partial<AutoCloseResult> = {}): AutoCloseResult => ({
    checked: 0,
    closed: 0,
    skipped: 0,
    unchanged: 0,
    failed: 0,
    truncated: false,
    stopped: false,
    durationMs: 1,
    ...overrides,
  });

  it('is off in tests and at 0, otherwise its own interval', () => {
    expect(
      autoCloseIntervalMs({ NODE_ENV: 'test', AUTO_CLOSE_SWEEP_INTERVAL_SECONDS: 300 }),
    ).toBeNull();
    expect(
      autoCloseIntervalMs({ NODE_ENV: 'production', AUTO_CLOSE_SWEEP_INTERVAL_SECONDS: 0 }),
    ).toBeNull();
    expect(
      autoCloseIntervalMs({ NODE_ENV: 'production', AUTO_CLOSE_SWEEP_INTERVAL_SECONDS: 300 }),
    ).toBe(300_000);
  });

  it('runs once per interval after start, never overlapping, and stops cleanly', async () => {
    let finish!: (r: AutoCloseResult) => void;
    const sweep = vi.fn(() => new Promise<AutoCloseResult>((resolve) => (finish = resolve)));
    const job = createAutoCloseScheduler({ intervalMs: 60_000, sweep, logger: silent });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sweep).not.toHaveBeenCalled();

    job.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000); // still running: no second run
    expect(sweep).toHaveBeenCalledOnce();

    const stopping = job.stop();
    finish(result({ stopped: true }));
    await stopping;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sweep).toHaveBeenCalledOnce();
  });

  it('logs aggregate counts only', async () => {
    const logs = captureLogs();
    const sweep = vi.fn(() =>
      Promise.resolve(result({ checked: 4, closed: 3, unchanged: 1, durationMs: 9 })),
    );
    const job = createAutoCloseScheduler({
      intervalMs: 60_000,
      sweep,
      logger: createLogger({ level: 'info', version: 'test', destination: logs.stream }),
    });
    job.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await job.stop();
    expect(logs.lines.find((l) => l.msg === 'Auto-close sweep finished')).toMatchObject({
      level: 'info',
      checked: 4,
      closed: 3,
      unchanged: 1,
      durationMs: 9,
    });
  });
});
