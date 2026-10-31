import { z } from 'zod';
import type { TicketPriority } from './tickets.ts';

// Contracts for the organization's SLA policy (docs/architecture/data-model.md, "SLA
// policies"). v1 manages one policy per organization, its default: the one new tickets take
// their due dates from. The organization is always the session's active one.

/**
 * Bounds of one target, in minutes of calendar time. The lower bound and "resolution ≥ first
 * response" match `SlaTarget_minutes_check`; the upper bound (one year, like auto-close) keeps
 * due dates sensible and is enforced here only.
 */
export const SLA_TARGET_MIN_MINUTES = 1;
export const SLA_TARGET_MAX_MINUTES = 365 * 24 * 60;

export const slaTargetMinutesSchema = z
  .int({ error: 'Must be a whole number of minutes' })
  .min(SLA_TARGET_MIN_MINUTES, { error: 'Must be at least 1 minute' })
  .max(SLA_TARGET_MAX_MINUTES, { error: 'Must be at most 365 days' });

/** One priority's targets as an admin submits them. */
export const slaTargetInputSchema = z
  .strictObject({
    firstResponseMinutes: slaTargetMinutesSchema,
    resolutionMinutes: slaTargetMinutesSchema,
  })
  .refine((target) => target.resolutionMinutes >= target.firstResponseMinutes, {
    error: 'Must be at least the first-response target',
    path: ['resolutionMinutes'],
  });
export type SlaTargetInput = z.infer<typeof slaTargetInputSchema>;

/**
 * A full replacement of the policy's targets: every priority, nothing else. A partial or
 * unknown priority is refused, so a save can never leave a priority without targets.
 */
export const updateSlaPolicyRequestSchema = z.strictObject({
  targets: z.strictObject({
    URGENT: slaTargetInputSchema,
    HIGH: slaTargetInputSchema,
    NORMAL: slaTargetInputSchema,
    LOW: slaTargetInputSchema,
  } satisfies Record<TicketPriority, typeof slaTargetInputSchema>),
});
export type UpdateSlaPolicyRequest = z.infer<typeof updateSlaPolicyRequestSchema>;

const storedTargetSchema = z
  .object({ firstResponseMinutes: z.int(), resolutionMinutes: z.int() })
  .nullable();

export const slaPolicySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  updatedAt: z.iso.datetime(),
  /** `null` for a priority with no target row (older data): its tickets get no due dates. */
  targets: z.object({
    URGENT: storedTargetSchema,
    HIGH: storedTargetSchema,
    NORMAL: storedTargetSchema,
    LOW: storedTargetSchema,
  } satisfies Record<TicketPriority, typeof storedTargetSchema>),
});
export type SlaPolicy = z.infer<typeof slaPolicySchema>;

/**
 * `policy` is `null` when the organization has no default policy (created before policies
 * were added at sign-up): its tickets get no due dates until an admin saves one.
 */
export const slaPolicyResponseSchema = z.object({ policy: slaPolicySchema.nullable() });
export type SlaPolicyResponse = z.infer<typeof slaPolicyResponseSchema>;
