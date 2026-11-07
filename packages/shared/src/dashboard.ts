import { z } from 'zod';
import { roleSchema } from './roles.ts';
import { slaStatusSchema } from './sla-status.ts';
import { ticketPrioritySchema } from './tickets.ts';

/**
 * `GET /api/v1/dashboard`: live metrics for the session's active organization, computed from
 * PostgreSQL at request time. Definitions: docs/architecture/dashboard.md.
 */

/** The trailing window, in days, for the response-time averages. */
export const DASHBOARD_WINDOW_DAYS = 30;

/** At most this many tickets are listed as needing SLA attention. */
export const DASHBOARD_ATTENTION_LIMIT = 5;

/**
 * Whose tickets the metrics cover, decided by the API from the caller's role:
 * - `organization` (`analytics:read-all`: owners and admins): every ticket in the organization;
 * - `own` (`analytics:read-own` only: agents): tickets currently assigned to the caller.
 */
export const DASHBOARD_SCOPES = ['organization', 'own'] as const;
export const dashboardScopeSchema = z.enum(DASHBOARD_SCOPES);
export type DashboardScope = z.infer<typeof dashboardScopeSchema>;

const count = z.number().int().nonnegative();

/** An average over `count` tickets, or `null` when there were none (never 0 for "no data"). */
const durationAverageSchema = z
  .object({ count, averageSeconds: z.number().nonnegative().nullable() })
  .refine((value) => (value.count === 0) === (value.averageSeconds === null), {
    message: 'averageSeconds is null exactly when count is 0',
  });

/** Active tickets by overall SLA state, exactly as the inbox badges classify them now. */
const slaStatusCountsSchema = z.object({
  none: count,
  met: count,
  on_track: count,
  at_risk: count,
  first_response_breached: count,
  resolution_breached: count,
});

const attentionTicketSchema = z.object({
  number: z.number().int().positive(),
  subject: z.string(),
  priority: ticketPrioritySchema,
  status: slaStatusSchema.extract(['at_risk', 'first_response_breached', 'resolution_breached']),
  /** The target that makes it urgent: the breached one, else the at-risk one due first. */
  target: z.enum(['firstResponse', 'resolution']),
  dueAt: z.iso.datetime().nullable(),
});
export type DashboardAttentionTicket = z.infer<typeof attentionTicketSchema>;

const agentWorkloadSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  role: roleSchema,
  /** Active tickets assigned to this member, in total and per active status. */
  active: count,
  open: count,
  pending: count,
  onHold: count,
  atRisk: count,
  /** Either target breached (overall state `first_response_breached` or `resolution_breached`). */
  breached: count,
});
export type DashboardAgentWorkload = z.infer<typeof agentWorkloadSchema>;

export const dashboardSummaryResponseSchema = z.object({
  scope: dashboardScopeSchema,
  generatedAt: z.iso.datetime(),
  tickets: z.object({
    /** Every ticket in scope, by its current status (all time). */
    byStatus: z.object({
      OPEN: count,
      PENDING: count,
      ON_HOLD: count,
      SOLVED: count,
      CLOSED: count,
    }),
    /** OPEN + PENDING + ON_HOLD: the statuses whose resolution clock is still running. */
    active: count,
    /** Active tickets without a public agent reply yet (the first-response clock is running). */
    awaitingFirstResponse: count,
    /** Active tickets with no assignee; `null` in the `own` scope, which covers none. */
    unassigned: count.nullable(),
  }),
  sla: z.object({
    active: slaStatusCountsSchema,
    attention: z.array(attentionTicketSchema).max(DASHBOARD_ATTENTION_LIMIT),
  }),
  responseTimes: z.object({
    windowDays: z.number().int().positive(),
    windowStart: z.iso.datetime(),
    /** Created → first public agent reply, for first replies sent inside the window. */
    firstResponse: durationAverageSchema,
    /** Created → solved, for tickets (now solved or closed) whose solve is inside the window. */
    resolution: durationAverageSchema,
  }),
  /**
   * Members and their active tickets, busiest first. Every member in the `organization` scope
   * (also those with none), only the caller in the `own` scope.
   */
  agents: z.array(agentWorkloadSchema),
});
export type DashboardSummary = z.infer<typeof dashboardSummaryResponseSchema>;
