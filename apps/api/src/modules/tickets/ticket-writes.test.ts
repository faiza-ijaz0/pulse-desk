import type { TicketPriority } from '@pulsedesk/shared';
import { describe, expect, it } from 'vitest';
import type { TenantContext } from '../../http/auth-context.ts';
import { createTicketWrites } from './ticket-writes.ts';
import type {
  LockedTicket,
  SlaTarget,
  TicketChanges,
  TicketsRepository,
  TicketWriteScope,
} from './tickets.repository.ts';

// Priority changes and SLA due dates, without a database: an in-memory write scope records
// what update() would write. (The API integration suite covers the real repository.)
const MINUTE = 60_000;
const CREATED = new Date('2026-10-20T08:00:00.000Z');
const at = (minutes: number) => new Date(CREATED.getTime() + minutes * MINUTE);

// Minutes from creation, per priority, as in a default policy.
const TARGETS: Record<TicketPriority, { firstResponse: number; resolution: number }> = {
  URGENT: { firstResponse: 30, resolution: 240 },
  HIGH: { firstResponse: 60, resolution: 480 },
  NORMAL: { firstResponse: 240, resolution: 1440 },
  LOW: { firstResponse: 480, resolution: 4320 },
};

const tenant: TenantContext = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  role: 'AGENT',
  requestId: 'test-request',
};

function urgentTicket(overrides: Partial<LockedTicket> = {}): LockedTicket {
  return {
    id: '00000000-0000-4000-8000-000000000003',
    number: 1,
    status: 'OPEN',
    priority: 'URGENT',
    assigneeUserId: null,
    teamId: null,
    slaPolicyId: '00000000-0000-4000-8000-000000000004',
    createdAt: CREATED,
    firstResponseDueAt: at(TARGETS.URGENT.firstResponse),
    resolutionDueAt: at(TARGETS.URGENT.resolution),
    firstRespondedAt: null,
    solvedAt: null,
    closedAt: null,
    tags: [],
    ...overrides,
  };
}

/** Changes the ticket's priority at `now` and returns what update() wrote to the ticket. */
async function changePriority(
  ticket: LockedTicket,
  priority: TicketPriority,
  now: Date,
): Promise<{ changes: TicketChanges; eventTypes: string[] }> {
  const written: { changes?: TicketChanges; eventTypes: string[] } = { eventTypes: [] };
  const scope = {
    existingReferences: () =>
      Promise.resolve({ userIds: new Set(), teamIds: new Set(), tagIds: new Set() }),
    lockTicket: () => Promise.resolve(ticket),
    slaTarget: (slaPolicyId: string, p: TicketPriority): Promise<SlaTarget> =>
      Promise.resolve({
        slaPolicyId,
        firstResponseMinutes: TARGETS[p].firstResponse,
        resolutionMinutes: TARGETS[p].resolution,
      }),
    updateTicket: (_id: string, changes: TicketChanges) => {
      written.changes = changes;
      return Promise.resolve();
    },
    changeTags: () => Promise.resolve(),
    addEvents: (_id: string, _userId: string, _at: Date, events: { type: string }[]) => {
      written.eventTypes.push(...events.map((e) => e.type));
      return Promise.resolve();
    },
  } as unknown as TicketWriteScope;
  const repository = {
    write: (_organizationId: string, fn: (s: TicketWriteScope) => Promise<number>) => fn(scope),
  } as unknown as TicketsRepository;

  const writes = createTicketWrites({ repository, clock: { now: () => now } });
  await writes.update(tenant, ticket.number, { priority });
  if (!written.changes) throw new Error('update() wrote nothing');
  return { changes: written.changes, eventTypes: written.eventTypes };
}

describe('changing priority: SLA due dates', () => {
  it('moves due dates that have not been reached yet to the new priority', async () => {
    const { changes, eventTypes } = await changePriority(urgentTicket(), 'LOW', at(10));
    expect(changes).toMatchObject({
      priority: 'LOW',
      firstResponseDueAt: at(TARGETS.LOW.firstResponse),
      resolutionDueAt: at(TARGETS.LOW.resolution),
    });
    expect(eventTypes).toEqual(['PRIORITY_CHANGED']);
  });

  it('keeps a due date that has passed, so lowering the priority does not undo a breach', async () => {
    // First response was due at 30 min and is unmet at 45 min; resolution (240 min) isn't due yet.
    const { changes, eventTypes } = await changePriority(urgentTicket(), 'LOW', at(45));
    expect(changes.priority).toBe('LOW');
    expect(changes).not.toHaveProperty('firstResponseDueAt');
    expect(changes.resolutionDueAt).toEqual(at(TARGETS.LOW.resolution));
    expect(eventTypes).toEqual(['PRIORITY_CHANGED']);
  });

  it('keeps a due date reached exactly at the time of the change', async () => {
    const { changes } = await changePriority(urgentTicket(), 'LOW', at(30));
    expect(changes).not.toHaveProperty('firstResponseDueAt');
  });

  it('keeps both due dates once both have passed, for any new priority', async () => {
    for (const priority of ['LOW', 'HIGH'] as const) {
      const { changes } = await changePriority(urgentTicket(), priority, at(300));
      expect(changes, priority).not.toHaveProperty('firstResponseDueAt');
      expect(changes, priority).not.toHaveProperty('resolutionDueAt');
      expect(changes.priority).toBe(priority);
    }
  });

  it('keeps a passed resolution due date on a reopened ticket', async () => {
    const reopened = urgentTicket({ firstRespondedAt: at(5), solvedAt: null });
    const { changes } = await changePriority(reopened, 'LOW', at(300));
    expect(changes).not.toHaveProperty('resolutionDueAt');
  });

  it('still leaves met targets alone', async () => {
    const replied = urgentTicket({ firstRespondedAt: at(5) });
    const { changes } = await changePriority(replied, 'LOW', at(10));
    expect(changes).not.toHaveProperty('firstResponseDueAt');
    expect(changes.resolutionDueAt).toEqual(at(TARGETS.LOW.resolution));
  });
});
