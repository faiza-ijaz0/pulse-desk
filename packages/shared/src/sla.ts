import type { SlaEvaluation, SlaStatus, SlaTargetState } from './sla-status.ts';
import { isTicketActive, type TicketPriority, type TicketStatus } from './tickets.ts';

/** The name of the policy every new organization starts with. */
export const DEFAULT_SLA_POLICY_NAME = 'Standard';

/**
 * Targets of the default policy, in minutes from ticket creation (calendar time). Every new
 * organization gets them at sign-up (apps/api auth repository), and the development seed
 * uses them too. They satisfy `SlaTarget_minutes_check` (first response > 0, resolution ≥
 * first response).
 */
export const DEFAULT_SLA_TARGETS: Readonly<
  Record<TicketPriority, { firstResponseMinutes: number; resolutionMinutes: number }>
> = {
  URGENT: { firstResponseMinutes: 30, resolutionMinutes: 4 * 60 },
  HIGH: { firstResponseMinutes: 60, resolutionMinutes: 8 * 60 },
  NORMAL: { firstResponseMinutes: 4 * 60, resolutionMinutes: 24 * 60 },
  LOW: { firstResponseMinutes: 8 * 60, resolutionMinutes: 72 * 60 },
};

/**
 * A target counts as at risk once no more than this share of its window (ticket creation to
 * due date) is left: 25 % is 7.5 minutes of a 30-minute urgent reply target, 18 hours of a
 * three-day low-priority resolution target. A share rather than a fixed duration, so one
 * threshold fits every priority.
 */
export const SLA_AT_RISK_REMAINING_FRACTION = 0.25;

/** The ticket fields SLA evaluation reads (all stored on `Ticket`). */
export type SlaTicketState = {
  status: TicketStatus;
  createdAt: Date;
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  firstRespondedAt: Date | null;
  solvedAt: Date | null;
  closedAt: Date | null;
  firstResponseBreachedAt: Date | null;
  resolutionBreachedAt: Date | null;
};

/*
 * One target at one moment (`SlaTargetState`, sla-status.ts):
 * - `none`: the ticket has no due date for it (no SLA policy applied at creation);
 * - `on_track` / `at_risk`: unmet, due date not passed yet;
 * - `met`: its clock stopped at or before the due date;
 * - `breached`: a breach was recorded, its clock stopped after the due date, or it is still
 *   running past it.
 *
 * The ticket's overall state (`SlaStatus`) is the most urgent of its two targets, a breach
 * first. When both are breached it is `resolution_breached`; the per-target states keep the
 * detail.
 */

function evaluateTarget(
  startedAt: Date,
  dueAt: Date | null,
  stoppedAt: Date | null,
  breachedAt: Date | null,
  now: Date,
): SlaTargetState {
  // A recorded breach is history: no later reply, solve or due-date change undoes it.
  if (breachedAt !== null) return 'breached';
  if (dueAt === null) return 'none';
  const due = dueAt.getTime();
  // At exactly the due date the target is still met; one millisecond later it is breached.
  if (stoppedAt !== null) return stoppedAt.getTime() <= due ? 'met' : 'breached';
  const remaining = due - now.getTime();
  if (remaining < 0) return 'breached';
  const window = due - startedAt.getTime();
  return remaining <= window * SLA_AT_RISK_REMAINING_FRACTION ? 'at_risk' : 'on_track';
}

/**
 * Classifies a ticket's SLA targets at `now` (docs/architecture/data-model.md, "SLA clocks").
 * Pure and deterministic: the caller passes the time (the API from its injected `Clock`), so
 * the API, the breach sweeper and the web app agree at any given moment.
 *
 * - First response stops at `firstRespondedAt` (the first PUBLIC agent reply) and nothing
 *   else: internal notes never set it, and solving a ticket without a public reply doesn't
 *   meet it — the clock keeps running against the due date.
 * - Resolution stops when the ticket leaves the active statuses, at `solvedAt` (`closedAt`
 *   if a closed ticket has none). Reopening clears `solvedAt` and keeps `resolutionDueAt`,
 *   so a ticket reopened after its due date is breached again at once.
 * - Due dates are taken as stored. They come from the SLA target at creation and follow
 *   priority changes while unmet and not yet reached; this function never recalculates them.
 * - A recorded breach (`firstResponseBreachedAt` / `resolutionBreachedAt`, set with its
 *   timeline event) keeps that target `breached` for good, even if a later change moves the
 *   due date out again or the ticket is reopened and solved in time.
 */
export function evaluateSla(ticket: SlaTicketState, now: Date): SlaEvaluation {
  const firstResponse = evaluateTarget(
    ticket.createdAt,
    ticket.firstResponseDueAt,
    ticket.firstRespondedAt,
    ticket.firstResponseBreachedAt,
    now,
  );
  const resolutionStoppedAt = isTicketActive(ticket.status)
    ? null
    : (ticket.solvedAt ?? ticket.closedAt);
  const resolution = evaluateTarget(
    ticket.createdAt,
    ticket.resolutionDueAt,
    resolutionStoppedAt,
    ticket.resolutionBreachedAt,
    now,
  );
  return { status: overallStatus(firstResponse, resolution), firstResponse, resolution };
}

function overallStatus(firstResponse: SlaTargetState, resolution: SlaTargetState): SlaStatus {
  if (resolution === 'breached') return 'resolution_breached';
  if (firstResponse === 'breached') return 'first_response_breached';
  const states = [firstResponse, resolution];
  if (states.includes('at_risk')) return 'at_risk';
  if (states.includes('on_track')) return 'on_track';
  if (states.includes('met')) return 'met';
  return 'none';
}
