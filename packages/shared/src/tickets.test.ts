import { describe, expect, it } from 'vitest';
import {
  MESSAGE_BODY_MAX_LENGTH,
  TICKET_LIST_DEFAULT_LIMIT,
  TICKET_LIST_MAX_LIMIT,
  TICKET_MAX_TAGS,
  TICKET_SUBJECT_MAX_LENGTH,
  createMessageRequestSchema,
  createTicketRequestSchema,
  decodeTicketCursor,
  encodeTicketCursor,
  ticketDetailResponseSchema,
  ticketListQuerySchema,
  ticketParamsSchema,
  updateTicketRequestSchema,
  type TicketCursor,
} from './tickets.ts';

const USER_ID = '0b7c4c1e-6a43-4c1e-9f3a-6f1c2a9d8e01';
const TEAM_ID = '5d2e9a10-3b7f-4a52-8c11-0e9b6f4d2a77';
const TAG_ID = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';

const cursor: TicketCursor = { sort: 'newest', at: '2026-10-20T08:30:00.123Z', number: 42 };

function issuesOf(input: unknown) {
  const result = ticketListQuerySchema.safeParse(input);
  return result.success ? [] : result.error.issues;
}

describe('ticketListQuerySchema', () => {
  it('applies the documented defaults to an empty query', () => {
    expect(ticketListQuerySchema.parse({})).toEqual({
      limit: TICKET_LIST_DEFAULT_LIMIT,
      sort: 'newest',
    });
    expect(TICKET_LIST_DEFAULT_LIMIT).toBe(25);
  });

  it('accepts every filter together', () => {
    expect(
      ticketListQuerySchema.parse({
        status: 'OPEN,PENDING',
        priority: 'URGENT',
        assignee: 'me',
        team: TEAM_ID,
        tag: TAG_ID,
        sort: 'oldest',
        limit: '10',
      }),
    ).toEqual({
      status: ['OPEN', 'PENDING'],
      priority: ['URGENT'],
      assignee: 'me',
      team: TEAM_ID,
      tag: TAG_ID,
      sort: 'oldest',
      limit: 10,
    });
  });

  it('removes duplicate status and priority values', () => {
    expect(ticketListQuerySchema.parse({ status: 'OPEN,OPEN,SOLVED' }).status).toEqual([
      'OPEN',
      'SOLVED',
    ]);
  });

  it.each(['me', 'unassigned', USER_ID])('accepts assignee=%s', (assignee) => {
    expect(ticketListQuerySchema.parse({ assignee }).assignee).toBe(assignee);
  });

  it.each(['none', TEAM_ID])('accepts team=%s', (team) => {
    expect(ticketListQuerySchema.parse({ team }).team).toBe(team);
  });

  it.each([
    ['status', 'open'],
    ['status', 'OPEN,'],
    ['status', ''],
    ['priority', 'CRITICAL'],
    ['assignee', 'someone'],
    ['assignee', 'ME'],
    ['team', 'unassigned'],
    ['team', 'not-a-uuid'],
    ['tag', 'billing'],
    ['sort', 'priority'],
  ])('rejects %s=%j', (key, value) => {
    const issues = issuesOf({ [key]: value });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path[0]).toBe(key);
  });

  it('rejects unknown query parameters', () => {
    const issues = issuesOf({ status: 'OPEN', organizationId: TEAM_ID, q: 'refund' });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('unrecognized_keys');
  });

  it('rejects repeated parameters, which Express parses as arrays', () => {
    expect(issuesOf({ status: ['OPEN', 'PENDING'] })[0]?.path).toEqual(['status']);
    expect(issuesOf({ limit: ['1', '2'] })[0]?.path).toEqual(['limit']);
  });

  it('caps limit at 100 and requires at least 1', () => {
    expect(ticketListQuerySchema.parse({ limit: '1' }).limit).toBe(1);
    expect(ticketListQuerySchema.parse({ limit: String(TICKET_LIST_MAX_LIMIT) }).limit).toBe(100);
    for (const limit of ['0', '101', '1000', '-1', '2.5', '1e2', ' 5', '', 'ten']) {
      expect(issuesOf({ limit })[0]?.path, `limit=${limit}`).toEqual(['limit']);
    }
  });

  it('decodes a valid cursor', () => {
    expect(ticketListQuerySchema.parse({ cursor: encodeTicketCursor(cursor) }).cursor).toEqual(
      cursor,
    );
  });

  it.each([
    'not-a-cursor',
    '!!!!',
    encodeTicketCursor(cursor).slice(0, -3),
    // Well-formed base64url of the wrong payloads:
    'e30', // {}
    'bnVsbA', // null
    'eyJzIjoibmV3ZXN0IiwiYSI6Inllc3RlcmRheSIsIm4iOjF9', // bad timestamp
    'eyJzIjoibmV3ZXN0IiwiYSI6IjIwMjYtMTAtMjBUMDg6MzA6MDAuMDAwWiIsIm4iOi0xfQ', // n = -1
    'a'.repeat(300),
  ])('rejects the malformed cursor %j', (value) => {
    expect(issuesOf({ cursor: value })[0]?.path).toEqual(['cursor']);
  });

  it('rejects a cursor issued for a different sort order', () => {
    const issues = issuesOf({ sort: 'oldest', cursor: encodeTicketCursor(cursor) });
    expect(issues[0]?.path).toEqual(['cursor']);
  });
});

describe('ticket cursors', () => {
  it('round-trip for every sort order', () => {
    for (const sort of ['newest', 'oldest', 'updated'] as const) {
      const value = { ...cursor, sort };
      const encoded = encodeTicketCursor(value);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeTicketCursor(encoded)).toEqual(value);
    }
  });

  it('decode to null instead of throwing on garbage', () => {
    expect(decodeTicketCursor('%%%')).toBeNull();
    expect(decodeTicketCursor('')).toBeNull();
  });
});

describe('ticketParamsSchema', () => {
  it('parses a positive ticket number', () => {
    expect(ticketParamsSchema.parse({ number: '17' })).toEqual({ number: 17 });
    expect(ticketParamsSchema.parse({ number: '2147483647' })).toEqual({ number: 2147483647 });
  });

  it.each(['0', '-3', '01', '1.5', 'abc', '2147483648', '99999999999', ' 7'])(
    'rejects %j',
    (number) => {
      expect(ticketParamsSchema.safeParse({ number }).success).toBe(false);
    },
  );
});

describe('ticketDetailResponseSchema', () => {
  const ticket = {
    id: USER_ID,
    number: 1,
    subject: 'Invoice question',
    status: 'OPEN',
    priority: 'NORMAL',
    channel: 'EMAIL',
    customer: { id: TAG_ID, name: null, email: 'ada@example.com' },
    assignee: null,
    team: null,
    tags: [],
    firstResponseDueAt: null,
    resolutionDueAt: null,
    firstRespondedAt: null,
    solvedAt: null,
    closedAt: null,
    createdAt: '2026-10-20T08:30:00.000Z',
    updatedAt: '2026-10-20T08:30:00.000Z',
  };
  const note = {
    id: TEAM_ID,
    visibility: 'INTERNAL',
    author: { type: 'AGENT', userId: USER_ID, name: 'Maya Chen' },
    body: 'Customer is on the legacy plan.',
    createdAt: '2026-10-20T08:31:00.000Z',
    editedAt: null,
  };

  it('keeps internal notes out of the public conversation', () => {
    const response = { ticket, conversation: [note], internalNotes: [], timeline: [] };
    expect(ticketDetailResponseSchema.safeParse(response).success).toBe(false);
    expect(
      ticketDetailResponseSchema.safeParse({
        ...response,
        conversation: [],
        internalNotes: [note],
      }).success,
    ).toBe(true);
  });

  it('validates timeline event data per event type', () => {
    const event = {
      id: TAG_ID,
      createdAt: '2026-10-20T08:32:00.000Z',
      actor: null,
      type: 'STATUS_CHANGED',
      data: { from: 'OPEN', to: 'PENDING' },
    };
    const base = { ticket, conversation: [], internalNotes: [] };
    expect(ticketDetailResponseSchema.safeParse({ ...base, timeline: [event] }).success).toBe(true);
    expect(
      ticketDetailResponseSchema.safeParse({
        ...base,
        timeline: [{ ...event, data: { from: 'OPEN', to: 'LOST' } }],
      }).success,
    ).toBe(false);
    expect(
      ticketDetailResponseSchema.safeParse({
        ...base,
        timeline: [{ ...event, type: 'SOMETHING_ELSE' }],
      }).success,
    ).toBe(false);
  });
});

describe('createTicketRequestSchema', () => {
  const valid = {
    subject: '  Card charged twice  ',
    customer: { email: ' Ada@Example.COM ', name: ' Ada Lovelace ' },
    message: '  I was charged twice.\n\nPlease help.  ',
  };

  it('normalizes input and applies defaults', () => {
    expect(createTicketRequestSchema.parse(valid)).toEqual({
      subject: 'Card charged twice',
      customer: { email: 'ada@example.com', name: 'Ada Lovelace' },
      message: 'I was charged twice.\n\nPlease help.',
      priority: 'NORMAL',
      channel: 'WEB',
      tagIds: [],
    });
  });

  it('accepts optional assignment and de-duplicates tag IDs', () => {
    const parsed = createTicketRequestSchema.parse({
      ...valid,
      priority: 'URGENT',
      assigneeUserId: USER_ID,
      teamId: null,
      tagIds: [TAG_ID, TAG_ID],
    });
    expect(parsed).toMatchObject({ priority: 'URGENT', assigneeUserId: USER_ID, teamId: null });
    expect(parsed.tagIds).toEqual([TAG_ID]);
  });

  it.each([
    ['subject', { subject: '   ' }],
    ['subject', { subject: 'x'.repeat(TICKET_SUBJECT_MAX_LENGTH + 1) }],
    ['customer', { customer: { email: 'not-an-email' } }],
    ['customer', { customer: { email: 'a@b.co', organizationId: TEAM_ID } }],
    ['message', { message: '  \n ' }],
    ['message', { message: 'x'.repeat(MESSAGE_BODY_MAX_LENGTH + 1) }],
    ['priority', { priority: 'CRITICAL' }],
    ['assigneeUserId', { assigneeUserId: 'me' }],
    ['tagIds', { tagIds: ['billing'] }],
    ['tagIds', { tagIds: Array.from({ length: TICKET_MAX_TAGS + 1 }, () => TAG_ID) }],
  ])('rejects an invalid %s', (field, patch) => {
    const result = createTicketRequestSchema.safeParse({ ...valid, ...patch });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path[0]).toBe(field);
  });

  it.each(['status', 'number', 'organizationId', 'slaPolicyId', 'customerId', 'firstRespondedAt'])(
    'rejects the server-controlled field %s',
    (field) => {
      const result = createTicketRequestSchema.safeParse({ ...valid, [field]: 'x' });
      expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
    },
  );
});

describe('updateTicketRequestSchema', () => {
  it('accepts each allowed field, and null to clear assignee and team', () => {
    expect(
      updateTicketRequestSchema.parse({
        status: 'SOLVED',
        priority: 'LOW',
        assigneeUserId: null,
        teamId: TEAM_ID,
        tagIds: [],
      }),
    ).toEqual({
      status: 'SOLVED',
      priority: 'LOW',
      assigneeUserId: null,
      teamId: TEAM_ID,
      tagIds: [],
    });
  });

  it('requires at least one field', () => {
    expect(updateTicketRequestSchema.safeParse({}).success).toBe(false);
  });

  it.each(['subject', 'customerId', 'slaPolicyId', 'number', 'closedAt', 'tags', 'organizationId'])(
    'rejects %s, which tickets endpoints may not change',
    (field) => {
      const result = updateTicketRequestSchema.safeParse({ status: 'OPEN', [field]: 'x' });
      expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
    },
  );

  it.each([
    { status: 'DONE' },
    { priority: 'urgent' },
    { assigneeUserId: 'unassigned' },
    { teamId: 'none' },
    { tagIds: [{ name: 'new-tag' }] },
  ])('rejects %j', (body) => {
    expect(updateTicketRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('createMessageRequestSchema', () => {
  it('trims the body and requires an explicit visibility', () => {
    expect(createMessageRequestSchema.parse({ body: ' Hi! ', visibility: 'INTERNAL' })).toEqual({
      body: 'Hi!',
      visibility: 'INTERNAL',
    });
    expect(createMessageRequestSchema.safeParse({ body: 'Hi!' }).success).toBe(false);
  });

  it.each([
    { body: '', visibility: 'PUBLIC' },
    { body: '   ', visibility: 'PUBLIC' },
    { body: 'x'.repeat(MESSAGE_BODY_MAX_LENGTH + 1), visibility: 'PUBLIC' },
    { body: 'Hi', visibility: 'PRIVATE' },
    { body: 'Hi', visibility: 'PUBLIC', authorType: 'CUSTOMER' },
    { body: 'Hi', visibility: 'PUBLIC', authorUserId: USER_ID },
  ])('rejects %j', (body) => {
    expect(createMessageRequestSchema.safeParse(body).success).toBe(false);
  });

  it('accepts a body at the maximum length', () => {
    const body = 'x'.repeat(MESSAGE_BODY_MAX_LENGTH);
    expect(createMessageRequestSchema.parse({ body, visibility: 'PUBLIC' }).body).toHaveLength(
      MESSAGE_BODY_MAX_LENGTH,
    );
  });
});
