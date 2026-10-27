import { TICKET_STATUS_LABELS, type TicketStatus } from './tickets.ts';

/**
 * Who is moving the ticket. Agents work tickets through the API; a customer reply reopens
 * a waiting or solved ticket; only the system's auto-close job closes solved tickets.
 */
export type StatusActor = 'agent' | 'customer' | 'system';

/** The status fields a transition reads and writes. */
export type TicketStatusState = {
  status: TicketStatus;
  solvedAt: Date | null;
  closedAt: Date | null;
};

export type StatusTransitionResult =
  { ok: true; changed: boolean; state: TicketStatusState } | { ok: false; reason: string };

// The lifecycle in docs/architecture/data-model.md, as data. Anything not listed is forbidden.
const TRANSITIONS: Record<StatusActor, Record<TicketStatus, readonly TicketStatus[]>> = {
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

/** Statuses `actor` may move a ticket in status `from` to (excluding `from` itself). */
export function allowedStatusTransitions(
  from: TicketStatus,
  actor: StatusActor,
): readonly TicketStatus[] {
  return TRANSITIONS[actor][from];
}

function forbiddenReason(from: TicketStatus, to: TicketStatus, actor: StatusActor): string {
  if (from === 'CLOSED') {
    return 'Closed tickets can’t change status. A new message from the customer starts a follow-up ticket.';
  }
  if (to === 'CLOSED') {
    return 'Tickets close automatically some time after they are solved. Mark the ticket Solved instead.';
  }
  if (from === 'SOLVED' && actor === 'agent') {
    return `Reopen the ticket before changing it to ${TICKET_STATUS_LABELS[to]}.`;
  }
  return `A ticket can’t move from ${TICKET_STATUS_LABELS[from]} to ${TICKET_STATUS_LABELS[to]}.`;
}

/**
 * Applies a status change and the timestamps that go with it — pure, so the API, the
 * future auto-close job and the web app all follow one rule set:
 * - entering SOLVED stamps `solvedAt`; reopening a solved ticket clears it;
 * - entering CLOSED stamps `closedAt` and keeps `solvedAt`.
 * Changing to the current status is allowed and changes nothing.
 */
export function transitionTicketStatus(
  current: TicketStatusState,
  to: TicketStatus,
  actor: StatusActor,
  now: Date,
): StatusTransitionResult {
  if (to === current.status) return { ok: true, changed: false, state: current };
  if (!TRANSITIONS[actor][current.status].includes(to)) {
    return { ok: false, reason: forbiddenReason(current.status, to, actor) };
  }

  const state: TicketStatusState = { ...current, status: to };
  if (to === 'SOLVED') state.solvedAt = now;
  if (current.status === 'SOLVED' && to === 'OPEN') state.solvedAt = null;
  if (to === 'CLOSED') state.closedAt = now;
  return { ok: true, changed: true, state };
}
