import { Prisma } from '@pulsedesk/db';
import type { SlaTicketState } from '@pulsedesk/shared';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.ts';
import type {
  BreachEventType,
  LockedSlaTicket,
  SlaSweepRepository,
  SlaSweepTarget,
  SweepCandidate,
} from '../src/modules/sla/sla-sweep.repository.ts';
import { breachesToRecord, createSlaSweepService } from '../src/modules/sla/sla-sweep.service.ts';
import { captureLogs } from './helpers.ts';

// The sweep's decisions and batching, without a database: an in-memory repository behaves
// like the real one (candidates in due-date order after a cursor, a row lock per ticket).
// test/integration/sla-sweep.int.test.ts covers the SQL, locking and constraints.

const MINUTE = 60_000;
const CREATED = new Date('2026-10-20T08:00:00.000Z');
const at = (minutes: number) => new Date(CREATED.getTime() + minutes * MINUTE);
const ORG = '00000000-0000-4000-8000-0000000000a1';

function state(overrides: Partial<SlaTicketState> = {}): SlaTicketState {
  return {
    status: 'OPEN',
    createdAt: CREATED,
    firstResponseDueAt: at(30),
    resolutionDueAt: at(240),
    firstRespondedAt: null,
    solvedAt: null,
    closedAt: null,
    firstResponseBreachedAt: null,
    resolutionBreachedAt: null,
    ...overrides,
  };
}

describe('breachesToRecord', () => {
  it('records a first response that is overdue with no reply', () => {
    expect(breachesToRecord(state(), at(31))).toEqual([
      { target: 'firstResponse', type: 'SLA_FIRST_RESPONSE_BREACHED', dueAt: at(30) },
    ]);
  });

  it('records nothing at exactly the due date (still met), and both targets once both pass', () => {
    expect(breachesToRecord(state(), at(30))).toEqual([]);
    expect(breachesToRecord(state(), at(241)).map((b) => b.target)).toEqual([
      'firstResponse',
      'resolution',
    ]);
  });

  it('records a late reply and a late solve, but not met targets', () => {
    expect(breachesToRecord(state({ firstRespondedAt: at(29) }), at(100))).toEqual([]);
    expect(breachesToRecord(state({ firstRespondedAt: at(31) }), at(100))).toEqual([
      { target: 'firstResponse', type: 'SLA_FIRST_RESPONSE_BREACHED', dueAt: at(30) },
    ]);
    const solvedLate = state({ status: 'SOLVED', firstRespondedAt: at(5), solvedAt: at(241) });
    expect(breachesToRecord(solvedLate, at(300)).map((b) => b.target)).toEqual(['resolution']);
    const solvedInTime = state({ status: 'SOLVED', firstRespondedAt: at(5), solvedAt: at(200) });
    expect(breachesToRecord(solvedInTime, at(300))).toEqual([]);
  });

  it('records nothing already recorded, and nothing without a due date', () => {
    expect(breachesToRecord(state({ firstResponseBreachedAt: at(31) }), at(100))).toEqual([]);
    expect(
      breachesToRecord(state({ firstResponseDueAt: null, resolutionDueAt: null }), at(10_000)),
    ).toEqual([]);
  });

  it('follows the due date as stored after a priority change moved it later', () => {
    // Not yet due under the new (later) date, so nothing to record.
    expect(breachesToRecord(state({ firstResponseDueAt: at(480) }), at(100))).toEqual([]);
  });
});

type FakeTicket = LockedSlaTicket & { id: string; organizationId: string };

/** An in-memory stand-in for the repository, with the same contract. */
function fakeRepository(
  tickets: FakeTicket[],
  options: { locked?: Set<string>; failOn?: Map<string, Error>; existingEvents?: string[] } = {},
) {
  const events = new Set(options.existingEvents ?? []); // `${ticketId}:${type}`
  const created: { ticketId: string; type: BreachEventType; dueAt: string; at: Date }[] = [];
  const calls: { target: SlaSweepTarget; after: string | null; limit: number }[] = [];

  const due = (t: FakeTicket, target: SlaSweepTarget) =>
    target === 'firstResponse' ? t.firstResponseDueAt : t.resolutionDueAt;
  const isCandidate = (t: FakeTicket, target: SlaSweepTarget, now: Date) => {
    const d = due(t, target);
    if (d === null || d >= now) return false;
    if (target === 'firstResponse') {
      return (
        t.firstResponseBreachedAt === null &&
        (t.firstRespondedAt === null || t.firstRespondedAt > d)
      );
    }
    return t.resolutionBreachedAt === null && (t.solvedAt === null || t.solvedAt > d);
  };
  const key = (t: FakeTicket, target: SlaSweepTarget) => `${due(t, target)!.toISOString()}|${t.id}`;

  const repository: SlaSweepRepository = {
    findCandidates(target, now, after, limit) {
      calls.push({ target, after: after?.id ?? null, limit });
      const ordered = tickets
        .filter((t) => isCandidate(t, target, now))
        .sort((a, b) => key(a, target).localeCompare(key(b, target)));
      const start = after ? ordered.findIndex((t) => t.id === after.id) + 1 : 0;
      return Promise.resolve(
        ordered.slice(start, start + limit).map((t): SweepCandidate => ({
          id: t.id,
          organizationId: t.organizationId,
          dueAt: due(t, target)!.toISOString(),
        })),
      );
    },
    async withLockedTicket(candidate, fn) {
      const failure = options.failOn?.get(candidate.id);
      if (failure) throw failure;
      if (options.locked?.has(candidate.id)) return null;
      const ticket = tickets.find(
        (t) => t.id === candidate.id && t.organizationId === candidate.organizationId,
      );
      if (!ticket) return null;
      return fn({
        ticket: { ...ticket },
        hasBreachEvent: (type) => Promise.resolve(events.has(`${ticket.id}:${type}`)),
        addBreachEvent(type, dueAt, when) {
          events.add(`${ticket.id}:${type}`);
          created.push({ ticketId: ticket.id, type, dueAt: dueAt.toISOString(), at: when });
          return Promise.resolve();
        },
        markBreached(target, when) {
          const field =
            target === 'firstResponse' ? 'firstResponseBreachedAt' : 'resolutionBreachedAt';
          if (ticket[field] !== null) return Promise.resolve(false);
          ticket[field] = when;
          return Promise.resolve(true);
        },
      });
    },
  };
  return { repository, created, calls };
}

let sequence = 0;
function fakeTicket(overrides: Partial<FakeTicket> = {}): FakeTicket {
  sequence++;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    organizationId: ORG,
    updatedAt: CREATED,
    ...state(),
    ...overrides,
  };
}

const silent = createLogger({ level: 'silent', version: 'test' });
const clockAt = (date: Date) => ({ now: () => date });

describe('SLA sweep service', () => {
  it('records each overdue target once, with its due date, as of the run time', async () => {
    const overdue = fakeTicket();
    const met = fakeTicket({ firstRespondedAt: at(10) });
    const noSla = fakeTicket({ firstResponseDueAt: null, resolutionDueAt: null });
    const { repository, created } = fakeRepository([overdue, met, noSla]);
    const service = createSlaSweepService({
      repository,
      clock: clockAt(at(100)),
      logger: silent,
      batchSize: 10,
    });

    const result = await service.sweep();
    expect(result).toMatchObject({
      checked: 1,
      recorded: { firstResponse: 1, resolution: 0 },
      skipped: 0,
      failed: 0,
      truncated: false,
      stopped: false,
    });
    expect(created).toEqual([
      {
        ticketId: overdue.id,
        type: 'SLA_FIRST_RESPONSE_BREACHED',
        dueAt: at(30).toISOString(),
        at: at(100),
      },
    ]);
    expect(overdue.firstResponseBreachedAt).toEqual(at(100));
    expect(met.firstResponseBreachedAt).toBeNull();
  });

  it('is idempotent: a second run, or a fresh service after a restart, records nothing', async () => {
    const tickets = [fakeTicket(), fakeTicket()];
    const { repository, created } = fakeRepository(tickets);
    const make = () =>
      createSlaSweepService({ repository, clock: clockAt(at(300)), logger: silent, batchSize: 10 });

    expect((await make().sweep()).recorded).toEqual({ firstResponse: 2, resolution: 2 });
    expect((await make().sweep()).recorded).toEqual({ firstResponse: 0, resolution: 0 });
    expect(created).toHaveLength(4);
  });

  it('repairs a missing marker without adding a second event', async () => {
    const ticket = fakeTicket();
    const { repository, created } = fakeRepository([ticket], {
      existingEvents: [`${ticket.id}:SLA_FIRST_RESPONSE_BREACHED`],
    });
    const service = createSlaSweepService({
      repository,
      clock: clockAt(at(100)),
      logger: silent,
      batchSize: 10,
    });
    const result = await service.sweep();
    expect(result.recorded.firstResponse).toBe(1);
    expect(created).toEqual([]);
    expect(ticket.firstResponseBreachedAt).toEqual(at(100));
  });

  it('processes bounded batches in due-date order, continuing from a cursor', async () => {
    const tickets = Array.from({ length: 5 }, (_, i) => fakeTicket({ firstResponseDueAt: at(i) }));
    const { repository, calls } = fakeRepository(tickets);
    const service = createSlaSweepService({
      repository,
      clock: clockAt(at(100)),
      logger: silent,
      batchSize: 2,
      maxBatchesPerTarget: 2,
    });

    const first = await service.sweep();
    expect(first).toMatchObject({ checked: 4, truncated: true });
    expect(first.recorded.firstResponse).toBe(4);
    const firstResponseCalls = calls.filter((c) => c.target === 'firstResponse');
    expect(firstResponseCalls).toEqual([
      { target: 'firstResponse', after: null, limit: 2 },
      { target: 'firstResponse', after: tickets[1]!.id, limit: 2 },
    ]);

    // The next run picks up what the limit left behind.
    const second = await service.sweep();
    expect(second.recorded.firstResponse).toBe(1);
    expect(tickets.every((t) => t.firstResponseBreachedAt !== null)).toBe(true);
  });

  it('skips a ticket another transaction holds, and records it on a later run', async () => {
    const ticket = fakeTicket();
    const locked = new Set([ticket.id]);
    const { repository } = fakeRepository([ticket], { locked });
    const service = createSlaSweepService({
      repository,
      clock: clockAt(at(100)),
      logger: silent,
      batchSize: 10,
    });

    expect(await service.sweep()).toMatchObject({ checked: 1, skipped: 1 });
    expect(ticket.firstResponseBreachedAt).toBeNull();
    locked.clear();
    expect((await service.sweep()).recorded.firstResponse).toBe(1);
  });

  it('logs a failing ticket without its data and carries on with the rest', async () => {
    const broken = fakeTicket({ firstResponseDueAt: at(1) });
    const fine = fakeTicket({ firstResponseDueAt: at(2) });
    const { repository } = fakeRepository([broken, fine], {
      failOn: new Map([[broken.id, new Error('constraint')]]),
    });
    const logs = captureLogs();
    const logger = createLogger({ level: 'info', version: 'test', destination: logs.stream });
    const service = createSlaSweepService({
      repository,
      clock: clockAt(at(100)),
      logger,
      batchSize: 10,
    });

    const result = await service.sweep();
    expect(result).toMatchObject({ failed: 1, recorded: { firstResponse: 1 } });
    expect(fine.firstResponseBreachedAt).not.toBeNull();
    const line = logs.lines.find((l) => l.msg === 'SLA sweep could not process a ticket');
    expect(line).toMatchObject({
      ticketId: broken.id,
      organizationId: ORG,
      target: 'firstResponse',
    });
  });

  it('ends the run on a database outage instead of failing ticket by ticket', async () => {
    const outage = new Prisma.PrismaClientKnownRequestError('down', {
      code: 'P1001',
      clientVersion: 'test',
    });
    const first = fakeTicket({ firstResponseDueAt: at(1) });
    const { repository } = fakeRepository([first, fakeTicket({ firstResponseDueAt: at(2) })], {
      failOn: new Map([[first.id, outage]]),
    });
    const service = createSlaSweepService({
      repository,
      clock: clockAt(at(100)),
      logger: silent,
      batchSize: 10,
    });
    await expect(service.sweep()).rejects.toBe(outage);
  });

  it('stops between tickets when asked to (shutdown)', async () => {
    const tickets = [
      fakeTicket({ firstResponseDueAt: at(1) }),
      fakeTicket({ firstResponseDueAt: at(2) }),
    ];
    const { repository } = fakeRepository(tickets);
    const service = createSlaSweepService({
      repository,
      clock: clockAt(at(100)),
      logger: silent,
      batchSize: 10,
    });
    let processed = 0;
    const result = await service.sweep({ shouldStop: () => processed++ >= 1 });
    expect(result).toMatchObject({ checked: 1, stopped: true });
    expect(tickets[0]!.firstResponseBreachedAt).not.toBeNull();
    expect(tickets[1]!.firstResponseBreachedAt).toBeNull();
  });
});
