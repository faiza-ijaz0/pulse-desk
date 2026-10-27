import { describe, expect, it } from 'vitest';
import {
  allowedStatusTransitions,
  transitionTicketStatus,
  type StatusActor,
} from './ticket-lifecycle.ts';
import { TICKET_STATUSES, type TicketStatus } from './tickets.ts';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const EARLIER = new Date('2026-10-20T08:00:00.000Z');

/**
 * The full lifecycle (docs/architecture/data-model.md, "Ticket lifecycle"): every pair not
 * listed for an actor is forbidden. Changing to the current status is a no-op, not a move.
 */
const ALLOWED: Record<StatusActor, Record<TicketStatus, TicketStatus[]>> = {
  agent: {
    OPEN: ['PENDING', 'ON_HOLD', 'SOLVED'],
    PENDING: ['OPEN', 'ON_HOLD', 'SOLVED'],
    ON_HOLD: ['OPEN', 'PENDING', 'SOLVED'],
    SOLVED: ['OPEN'],
    CLOSED: [],
  },
  customer: {
    OPEN: [],
    PENDING: ['OPEN'],
    ON_HOLD: ['OPEN'],
    SOLVED: ['OPEN'],
    CLOSED: [],
  },
  system: {
    OPEN: [],
    PENDING: [],
    ON_HOLD: [],
    SOLVED: ['CLOSED'],
    CLOSED: [],
  },
};

const ACTORS: StatusActor[] = ['agent', 'customer', 'system'];

function stateOf(status: TicketStatus) {
  return {
    status,
    solvedAt: status === 'SOLVED' || status === 'CLOSED' ? EARLIER : null,
    closedAt: status === 'CLOSED' ? EARLIER : null,
  };
}

describe('allowedStatusTransitions', () => {
  it.each(ACTORS)('lists exactly the documented moves for %s', (actor) => {
    for (const from of TICKET_STATUSES) {
      expect([...allowedStatusTransitions(from, actor)].sort(), `${actor}: ${from}`).toEqual(
        [...ALLOWED[actor][from]].sort(),
      );
    }
  });
});

describe('transitionTicketStatus', () => {
  const cases = ACTORS.flatMap((actor) =>
    TICKET_STATUSES.flatMap((from) =>
      TICKET_STATUSES.filter((to) => to !== from).map((to) => ({
        actor,
        from,
        to,
        allowed: ALLOWED[actor][from].includes(to),
      })),
    ),
  );

  it.each(cases)('$actor: $from → $to allowed=$allowed', ({ actor, from, to, allowed }) => {
    const result = transitionTicketStatus(stateOf(from), to, actor, NOW);
    expect(result.ok).toBe(allowed);
    if (result.ok) {
      expect(result.state.status).toBe(to);
    } else {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('treats the current status as a no-op that keeps every timestamp', () => {
    for (const status of TICKET_STATUSES) {
      for (const actor of ACTORS) {
        const state = stateOf(status);
        expect(transitionTicketStatus(state, status, actor, NOW)).toEqual({
          ok: true,
          changed: false,
          state,
        });
      }
    }
  });

  it('stamps solvedAt when a ticket is solved', () => {
    expect(transitionTicketStatus(stateOf('PENDING'), 'SOLVED', 'agent', NOW)).toEqual({
      ok: true,
      changed: true,
      state: { status: 'SOLVED', solvedAt: NOW, closedAt: null },
    });
  });

  it('clears solvedAt when a solved ticket is reopened, by an agent or a customer reply', () => {
    for (const actor of ['agent', 'customer'] as const) {
      expect(transitionTicketStatus(stateOf('SOLVED'), 'OPEN', actor, NOW)).toEqual({
        ok: true,
        changed: true,
        state: { status: 'OPEN', solvedAt: null, closedAt: null },
      });
    }
  });

  it('stamps closedAt and keeps solvedAt when the system closes a solved ticket', () => {
    expect(transitionTicketStatus(stateOf('SOLVED'), 'CLOSED', 'system', NOW)).toEqual({
      ok: true,
      changed: true,
      state: { status: 'CLOSED', solvedAt: EARLIER, closedAt: NOW },
    });
  });

  it('leaves timestamps alone for moves between active statuses', () => {
    expect(transitionTicketStatus(stateOf('OPEN'), 'ON_HOLD', 'agent', NOW)).toEqual({
      ok: true,
      changed: true,
      state: { status: 'ON_HOLD', solvedAt: null, closedAt: null },
    });
  });

  it.each<[TicketStatus, TicketStatus, RegExp]>([
    ['CLOSED', 'OPEN', /closed/i],
    ['SOLVED', 'CLOSED', /solved/i],
    ['SOLVED', 'PENDING', /reopen/i],
  ])('explains why %s → %s is forbidden', (from, to, pattern) => {
    const result = transitionTicketStatus(stateOf(from), to, 'agent', NOW);
    expect(result.ok ? null : result.reason).toMatch(pattern);
  });

  it('never mutates the state it is given', () => {
    const state = stateOf('OPEN');
    const copy = structuredClone(state);
    transitionTicketStatus(state, 'SOLVED', 'agent', NOW);
    expect(state).toEqual(copy);
  });
});
