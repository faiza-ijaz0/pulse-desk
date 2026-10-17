import { z } from 'zod';

// These lists must stay identical to the matching enums in packages/db/prisma/schema.prisma
// (enforced by packages/db/src/enum-parity.test.ts).

export const TICKET_STATUSES = ['OPEN', 'PENDING', 'ON_HOLD', 'SOLVED', 'CLOSED'] as const;
export const ticketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;

export const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export const ticketPrioritySchema = z.enum(TICKET_PRIORITIES);
export type TicketPriority = z.infer<typeof ticketPrioritySchema>;

export const TICKET_CHANNELS = ['WEB', 'EMAIL', 'API'] as const;
export const ticketChannelSchema = z.enum(TICKET_CHANNELS);
export type TicketChannel = z.infer<typeof ticketChannelSchema>;

/** Statuses in which the SLA resolution clock is still running. */
export const ACTIVE_TICKET_STATUSES: readonly TicketStatus[] = ['OPEN', 'PENDING', 'ON_HOLD'];

export function isTicketActive(status: TicketStatus): boolean {
  return ACTIVE_TICKET_STATUSES.includes(status);
}
