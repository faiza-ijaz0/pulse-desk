import {
  messageVisibilitySchema,
  ticketPrioritySchema,
  ticketStatusSchema,
  type TicketEventType,
} from '@pulsedesk/shared';
import { z } from 'zod';

/**
 * The stored shape of `TicketEvent.data` per event type — the persistence format, which
 * holds bare IDs. The API resolves those IDs within the ticket's organization before
 * returning the response shape (`timelineEventSchema` in @pulsedesk/shared). Writers must
 * produce exactly these shapes (docs/architecture/data-model.md, "Ticket timeline").
 */
const optionalId = z.uuid().nullable();
const change = <Value extends z.ZodType>(value: Value) =>
  z.strictObject({ from: value, to: value });

export const STORED_EVENT_DATA = {
  CREATED: z.strictObject({}),
  STATUS_CHANGED: change(ticketStatusSchema),
  PRIORITY_CHANGED: change(ticketPrioritySchema),
  ASSIGNED: z.strictObject({ fromUserId: optionalId, toUserId: optionalId }),
  TEAM_CHANGED: z.strictObject({ fromTeamId: optionalId, toTeamId: optionalId }),
  TAGS_CHANGED: z.strictObject({
    addedTagIds: z.array(z.uuid()),
    removedTagIds: z.array(z.uuid()),
  }),
  MESSAGE_ADDED: z.strictObject({ messageId: z.uuid(), visibility: messageVisibilitySchema }),
  SLA_FIRST_RESPONSE_BREACHED: z.strictObject({ dueAt: z.iso.datetime() }),
  SLA_RESOLUTION_BREACHED: z.strictObject({ dueAt: z.iso.datetime() }),
} satisfies Record<TicketEventType, z.ZodType>;

/** A stored event whose data matched its type's schema. */
export type StoredEvent = {
  [Type in TicketEventType]: { type: Type; data: z.infer<(typeof STORED_EVENT_DATA)[Type]> };
}[TicketEventType];

export function parseStoredEvent(type: TicketEventType, data: unknown): StoredEvent | null {
  const parsed = STORED_EVENT_DATA[type].safeParse(data);
  // The schema was picked by `type`, so the parsed data belongs to that variant.
  return parsed.success ? ({ type, data: parsed.data } as StoredEvent) : null;
}
