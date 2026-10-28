import { z } from 'zod';
import { decodeCursor, encodeCursor } from './cursor.ts';

// These lists must stay identical to the matching enums in packages/db/prisma/schema.prisma
// (enforced by packages/db/src/enum-parity.test.ts).

export const TICKET_STATUSES = ['OPEN', 'PENDING', 'ON_HOLD', 'SOLVED', 'CLOSED'] as const;
export const ticketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;

/** Display names, shared by the web app and API error messages. */
export const TICKET_STATUS_LABELS: Readonly<Record<TicketStatus, string>> = {
  OPEN: 'Open',
  PENDING: 'Pending',
  ON_HOLD: 'On hold',
  SOLVED: 'Solved',
  CLOSED: 'Closed',
};

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

export const MESSAGE_AUTHOR_TYPES = ['AGENT', 'CUSTOMER', 'SYSTEM'] as const;
export const messageAuthorTypeSchema = z.enum(MESSAGE_AUTHOR_TYPES);
export type MessageAuthorType = z.infer<typeof messageAuthorTypeSchema>;

export const MESSAGE_VISIBILITIES = ['PUBLIC', 'INTERNAL'] as const;
export const messageVisibilitySchema = z.enum(MESSAGE_VISIBILITIES);
export type MessageVisibility = z.infer<typeof messageVisibilitySchema>;

export const TICKET_EVENT_TYPES = [
  'CREATED',
  'STATUS_CHANGED',
  'PRIORITY_CHANGED',
  'ASSIGNED',
  'TEAM_CHANGED',
  'TAGS_CHANGED',
  'MESSAGE_ADDED',
  'SLA_FIRST_RESPONSE_BREACHED',
  'SLA_RESOLUTION_BREACHED',
] as const;
export const ticketEventTypeSchema = z.enum(TICKET_EVENT_TYPES);
export type TicketEventType = z.infer<typeof ticketEventTypeSchema>;

/** Who caused a ticket event: a person, or PulseDesk itself (SLA sweeps, auto-close). */
export const TICKET_EVENT_ACTOR_TYPES = ['USER', 'SYSTEM'] as const;
export const ticketEventActorTypeSchema = z.enum(TICKET_EVENT_ACTOR_TYPES);
export type TicketEventActorType = z.infer<typeof ticketEventActorTypeSchema>;

// ───────────────────────── List query ─────────────────────────

export const TICKET_LIST_DEFAULT_LIMIT = 25;
export const TICKET_LIST_MAX_LIMIT = 100;

/**
 * `newest` / `oldest` order by creation time, `updated` by last change (most recent first).
 * Every order breaks ties on the per-organization ticket number, so it is total.
 */
export const TICKET_SORTS = ['newest', 'oldest', 'updated'] as const;
export const ticketSortSchema = z.enum(TICKET_SORTS);
export type TicketSort = z.infer<typeof ticketSortSchema>;

/** Position after the last row of a page: that row's sort timestamp and ticket number. */
export type TicketCursor = { sort: TicketSort; at: string; number: number };

const MAX_CURSOR_LENGTH = 200;

const cursorPayloadSchema = z.strictObject({
  s: ticketSortSchema,
  a: z.iso.datetime(),
  n: z.int().positive(),
});

/** Opaque to clients: they pass back the `nextCursor` they were given, unchanged. */
export function encodeTicketCursor(cursor: TicketCursor): string {
  return encodeCursor({ s: cursor.sort, a: cursor.at, n: cursor.number });
}

/** The cursor's position, or null if the value is not a cursor this API issued. */
export function decodeTicketCursor(value: string): TicketCursor | null {
  const payload = decodeCursor(value, cursorPayloadSchema, MAX_CURSOR_LENGTH);
  return payload && { sort: payload.s, at: payload.a, number: payload.n };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A comma-separated list of enum values, e.g. `status=OPEN,PENDING`. Duplicates are dropped. */
function enumList<const T extends readonly [string, ...string[]]>(values: T, label: string) {
  const allowed: ReadonlySet<string> = new Set(values);
  const isAllowed = (value: string): value is T[number] => allowed.has(value);
  return z
    .string({ error: 'Must be a single comma-separated value' })
    .refine((raw) => raw.split(',').every(isAllowed), {
      error: `Must be a comma-separated list of ${label}: ${values.join(', ')}`,
    })
    .transform((raw) => [...new Set(raw.split(',').filter(isAllowed))]);
}

function singleValue(message: string, accept: (value: string) => boolean) {
  return z.string({ error: 'Must be a single value' }).refine(accept, { error: message });
}

/**
 * `GET /api/v1/tickets` query. Every filter is optional and they combine with AND.
 * Values arrive as strings; repeated parameters (which Express parses as arrays) and
 * unknown parameters are rejected rather than silently ignored.
 */
export const ticketListQuerySchema = z
  .strictObject({
    status: enumList(TICKET_STATUSES, 'statuses').optional(),
    priority: enumList(TICKET_PRIORITIES, 'priorities').optional(),
    /** `me`, `unassigned`, or a member's user ID. */
    assignee: singleValue(
      'Must be "me", "unassigned" or a user ID',
      (value) => value === 'me' || value === 'unassigned' || UUID_PATTERN.test(value),
    ).optional(),
    /** `none` (no team) or a team ID. */
    team: singleValue(
      'Must be "none" or a team ID',
      (value) => value === 'none' || UUID_PATTERN.test(value),
    ).optional(),
    tag: singleValue('Must be a tag ID', (value) => UUID_PATTERN.test(value)).optional(),
    /** A customer ID: that customer's ticket history. */
    customer: singleValue('Must be a customer ID', (value) => UUID_PATTERN.test(value)).optional(),
    sort: z.string({ error: 'Must be a single value' }).pipe(ticketSortSchema).default('newest'),
    limit: z
      .string({ error: 'Must be a single value' })
      .regex(/^\d{1,3}$/, { error: `Must be a whole number from 1 to ${TICKET_LIST_MAX_LIMIT}` })
      .transform(Number)
      .pipe(
        z
          .int()
          .min(1, { error: 'Must be at least 1' })
          .max(TICKET_LIST_MAX_LIMIT, { error: `Must be at most ${TICKET_LIST_MAX_LIMIT}` }),
      )
      .default(TICKET_LIST_DEFAULT_LIMIT),
    cursor: z
      .string({ error: 'Must be a single value' })
      .transform((value, ctx) => {
        const cursor = decodeTicketCursor(value);
        if (cursor === null) {
          ctx.addIssue({ code: 'custom', message: 'Invalid cursor' });
          return z.NEVER;
        }
        return cursor;
      })
      .optional(),
  })
  .superRefine((query, ctx) => {
    if (query.cursor !== undefined && query.cursor.sort !== query.sort) {
      ctx.addIssue({
        code: 'custom',
        path: ['cursor'],
        message: 'This cursor belongs to a different sort order; start again from the first page',
      });
    }
  });
export type TicketListQuery = z.output<typeof ticketListQuerySchema>;

export const ticketParamsSchema = z.object({
  number: z
    .string()
    .regex(/^[1-9]\d{0,9}$/, { error: 'Must be a ticket number' })
    .transform(Number)
    .pipe(z.int().max(2_147_483_647, { error: 'Must be a ticket number' })),
});

/** `GET /api/v1/tickets/:number` takes no query parameters. */
export const ticketDetailQuerySchema = z.strictObject({});

// ───────────────────────── Write requests ─────────────────────────

export const TICKET_SUBJECT_MAX_LENGTH = 200;
export const MESSAGE_BODY_MAX_LENGTH = 10_000;
export const TICKET_MAX_TAGS = 20;

/** Message text: surrounding whitespace is trimmed, line breaks inside are kept. */
export const messageBodySchema = z
  .string({ error: 'Write a message' })
  .trim()
  .min(1, 'Write a message')
  .max(MESSAGE_BODY_MAX_LENGTH, `Messages can be at most ${MESSAGE_BODY_MAX_LENGTH} characters`);

const subjectSchema = z
  .string({ error: 'Enter a subject' })
  .trim()
  .min(1, 'Enter a subject')
  .max(
    TICKET_SUBJECT_MAX_LENGTH,
    `Subjects can be at most ${TICKET_SUBJECT_MAX_LENGTH} characters`,
  );

/** Normalized like account emails (trimmed, lower-cased), with wording for an agent. */
export const customerEmailSchema = z
  .string({ error: 'Enter the customer’s email address' })
  .trim()
  .toLowerCase()
  .min(1, 'Enter the customer’s email address')
  .max(254, 'Email addresses can be at most 254 characters')
  .pipe(z.email({ error: 'Enter a valid email address' }));

const optionalReference = (label: string) =>
  z
    .uuid({ error: `Must be a ${label} ID` })
    .nullable()
    .optional();

/** A set of existing tag IDs. Tickets endpoints never create tags (that needs `tag:manage`). */
const tagIdsSchema = z
  .array(z.uuid({ error: 'Must be a tag ID' }), { error: 'Must be a list of tag IDs' })
  .max(TICKET_MAX_TAGS, `A ticket can have at most ${TICKET_MAX_TAGS} tags`)
  .transform((ids) => [...new Set(ids)]);

/**
 * `POST /api/v1/tickets`: an agent opens a ticket on a customer's behalf. `message` is the
 * customer's request and becomes the first, customer-authored message. The customer is
 * found by email within the organization, or created. Status, number, SLA and timestamps
 * are always set by the server.
 */
export const createTicketRequestSchema = z.strictObject({
  subject: subjectSchema,
  customer: z.strictObject({
    email: customerEmailSchema,
    name: z
      .string()
      .trim()
      .min(1, 'Enter a name or leave it out')
      .max(100, 'Names can be at most 100 characters')
      .optional(),
  }),
  message: messageBodySchema,
  priority: ticketPrioritySchema.default('NORMAL'),
  channel: ticketChannelSchema.default('WEB'),
  assigneeUserId: optionalReference('user'),
  teamId: optionalReference('team'),
  tagIds: tagIdsSchema.default([]),
});
export type CreateTicketRequest = z.input<typeof createTicketRequestSchema>;
export type CreateTicketInput = z.output<typeof createTicketRequestSchema>;

/**
 * `PATCH /api/v1/tickets/:number`. Only these fields can change; `null` clears the
 * assignee or team, and `tagIds` replaces the ticket's whole tag set.
 */
export const updateTicketRequestSchema = z
  .strictObject({
    status: ticketStatusSchema.optional(),
    priority: ticketPrioritySchema.optional(),
    assigneeUserId: optionalReference('user'),
    teamId: optionalReference('team'),
    tagIds: tagIdsSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { error: 'Change at least one field' });
export type UpdateTicketRequest = z.input<typeof updateTicketRequestSchema>;
export type UpdateTicketInput = z.output<typeof updateTicketRequestSchema>;

/**
 * `POST /api/v1/tickets/:number/messages`. The author is always the signed-in agent;
 * visibility must be chosen explicitly so nothing becomes public by default.
 */
export const createMessageRequestSchema = z.strictObject({
  body: messageBodySchema,
  visibility: messageVisibilitySchema,
});
export type CreateMessageRequest = z.infer<typeof createMessageRequestSchema>;

// ───────────────────────── Response DTOs ─────────────────────────

const timestamp = z.iso.datetime();

export const ticketCustomerSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  email: z.string(),
});
export type TicketCustomer = z.infer<typeof ticketCustomerSchema>;

export const ticketAssigneeSchema = z.object({ userId: z.uuid(), name: z.string() });
export type TicketAssignee = z.infer<typeof ticketAssigneeSchema>;

export const ticketTeamSchema = z.object({ id: z.uuid(), name: z.string() });
export type TicketTeam = z.infer<typeof ticketTeamSchema>;

export const ticketTagSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  color: z.string().nullable(),
});
export type TicketTag = z.infer<typeof ticketTagSchema>;

/** One inbox row. Carries no message content, so nothing internal can surface in a list. */
export const ticketSummarySchema = z.object({
  id: z.uuid(),
  number: z.int().positive(),
  subject: z.string(),
  status: ticketStatusSchema,
  priority: ticketPrioritySchema,
  channel: ticketChannelSchema,
  customer: ticketCustomerSchema,
  assignee: ticketAssigneeSchema.nullable(),
  team: ticketTeamSchema.nullable(),
  tags: z.array(ticketTagSchema),
  firstResponseDueAt: timestamp.nullable(),
  resolutionDueAt: timestamp.nullable(),
  firstRespondedAt: timestamp.nullable(),
  solvedAt: timestamp.nullable(),
  closedAt: timestamp.nullable(),
  /** When a breach was recorded; once set, the target stays breached (see `evaluateSla`). */
  firstResponseBreachedAt: timestamp.nullable(),
  resolutionBreachedAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type TicketSummary = z.infer<typeof ticketSummarySchema>;

export const ticketListResponseSchema = z.object({
  data: z.array(ticketSummarySchema),
  nextCursor: z.string().nullable(),
});
export type TicketListResponse = z.infer<typeof ticketListResponseSchema>;

/** `userId`/`name` are null once the author's account has been deleted. */
export const messageAuthorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('AGENT'), userId: z.uuid().nullable(), name: z.string().nullable() }),
  z.object({
    type: z.literal('CUSTOMER'),
    customerId: z.uuid(),
    name: z.string().nullable(),
    email: z.string(),
  }),
  z.object({ type: z.literal('SYSTEM') }),
]);
export type MessageAuthor = z.infer<typeof messageAuthorSchema>;

const messageFields = {
  id: z.uuid(),
  author: messageAuthorSchema,
  body: z.string(),
  createdAt: timestamp,
  editedAt: timestamp.nullable(),
};

/** A message the customer can see. */
export const conversationMessageSchema = z.object({
  ...messageFields,
  visibility: z.literal('PUBLIC'),
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

/** An agent-only note. It has its own response field, so it can never mix into the conversation. */
export const internalNoteSchema = z.object({
  ...messageFields,
  visibility: z.literal('INTERNAL'),
});
export type InternalNote = z.infer<typeof internalNoteSchema>;

/**
 * A member, team or tag referenced by event data, resolved within the ticket's organization.
 * `name` is null when it no longer exists there.
 */
export const timelineRefSchema = z.object({ id: z.uuid(), name: z.string().nullable() });
export type TimelineRef = z.infer<typeof timelineRefSchema>;

const eventFields = {
  id: z.uuid(),
  createdAt: timestamp,
  actorType: ticketEventActorTypeSchema,
  /** The user behind a USER event; null for SYSTEM events and for deleted accounts. */
  actor: z.object({ id: z.uuid(), name: z.string() }).nullable(),
};

function event<const Type extends TicketEventType, Data extends z.ZodType>(type: Type, data: Data) {
  return z.object({ ...eventFields, type: z.literal(type), data });
}

function change<Value extends z.ZodType>(value: Value) {
  return z.object({ from: value, to: value });
}

export const timelineEventSchema = z.discriminatedUnion('type', [
  event('CREATED', z.object({})),
  event('STATUS_CHANGED', change(ticketStatusSchema)),
  event('PRIORITY_CHANGED', change(ticketPrioritySchema)),
  event('ASSIGNED', change(timelineRefSchema.nullable())),
  event('TEAM_CHANGED', change(timelineRefSchema.nullable())),
  event(
    'TAGS_CHANGED',
    z.object({ added: z.array(timelineRefSchema), removed: z.array(timelineRefSchema) }),
  ),
  event('MESSAGE_ADDED', z.object({ messageId: z.uuid(), visibility: messageVisibilitySchema })),
  event('SLA_FIRST_RESPONSE_BREACHED', z.object({ dueAt: timestamp })),
  event('SLA_RESOLUTION_BREACHED', z.object({ dueAt: timestamp })),
]);
export type TimelineEvent = z.infer<typeof timelineEventSchema>;

/** `GET /api/v1/tickets/:number`. Every list is in chronological order. */
export const ticketDetailResponseSchema = z.object({
  ticket: ticketSummarySchema,
  conversation: z.array(conversationMessageSchema),
  internalNotes: z.array(internalNoteSchema),
  timeline: z.array(timelineEventSchema),
});
export type TicketDetailResponse = z.infer<typeof ticketDetailResponseSchema>;
