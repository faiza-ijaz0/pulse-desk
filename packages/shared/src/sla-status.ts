import { z } from 'zod';

// The SLA states as data, shared by `evaluateSla` (sla.ts) and the API contract (tickets.ts).
// This module imports nothing from either, so both can depend on it without an import cycle.

/** One target at one moment (see `evaluateSla`). */
export const SLA_TARGET_STATES = ['none', 'on_track', 'at_risk', 'met', 'breached'] as const;
export const slaTargetStateSchema = z.enum(SLA_TARGET_STATES);
export type SlaTargetState = z.infer<typeof slaTargetStateSchema>;

/** The ticket's overall SLA state: the most urgent of its two targets, a breach first. */
export const SLA_STATUSES = [
  'none',
  'met',
  'on_track',
  'at_risk',
  'first_response_breached',
  'resolution_breached',
] as const;
export const slaStatusSchema = z.enum(SLA_STATUSES);
export type SlaStatus = z.infer<typeof slaStatusSchema>;

/** A ticket's SLA as the API returns it: computed at response time, never stored. */
export const slaEvaluationSchema = z.object({
  status: slaStatusSchema,
  firstResponse: slaTargetStateSchema,
  resolution: slaTargetStateSchema,
});
export type SlaEvaluation = z.infer<typeof slaEvaluationSchema>;
