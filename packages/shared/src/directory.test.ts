import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from './cursor.ts';
import {
  CUSTOMER_LIST_DEFAULT_LIMIT,
  customerListQuerySchema,
  customerParamsSchema,
  decodeCustomerCursor,
  encodeCustomerCursor,
  updateCustomerRequestSchema,
} from './customers.ts';
import { hasPermission } from './roles.ts';
import { SEARCH_QUERY_MAX_LENGTH } from './search-text.ts';
import { searchQuerySchema } from './search.ts';
import { TAG_COLORS, createTagRequestSchema, updateTagRequestSchema } from './tags.ts';
import {
  createTeamRequestSchema,
  teamMemberParamsSchema,
  updateTeamRequestSchema,
} from './teams.ts';
import { ticketListQuerySchema } from './tickets.ts';

const ID = '5d2e9a10-3b7f-4a52-8c11-0e9b6f4d2a77';

describe('cursors', () => {
  it('round-trip non-ASCII payloads', () => {
    const payload = { e: 'jürgen.müller@exämple.com' };
    const encoded = encodeCursor(payload);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded, z.strictObject({ e: z.string() }), 500)).toEqual(payload);
  });
});

describe('customer cursors', () => {
  it('round-trip, including non-ASCII addresses', () => {
    for (const email of ['ada@example.com', 'jürgen@exämple.com']) {
      expect(decodeCustomerCursor(encodeCustomerCursor({ email }))).toEqual({ email });
    }
  });

  it.each(['', 'nope', encodeCursor({ e: '' }), encodeCursor({ x: 'a@b.co' }), 'a'.repeat(600)])(
    'reject %j',
    (value) => {
      expect(decodeCustomerCursor(value)).toBeNull();
    },
  );
});

describe('customerListQuerySchema', () => {
  it('applies defaults', () => {
    expect(customerListQuerySchema.parse({})).toEqual({ limit: CUSTOMER_LIST_DEFAULT_LIMIT });
  });

  it('trims the search text and decodes the cursor', () => {
    const cursor = encodeCustomerCursor({ email: 'm@example.com' });
    expect(customerListQuerySchema.parse({ q: '  Ada ', cursor, limit: '10' })).toEqual({
      q: 'Ada',
      cursor: { email: 'm@example.com' },
      limit: 10,
    });
  });

  it.each([
    ['q', ''],
    ['q', '   '],
    ['q', 'x'.repeat(SEARCH_QUERY_MAX_LENGTH + 1)],
    ['limit', '0'],
    ['limit', '101'],
    ['cursor', 'garbage!'],
  ])('rejects %s=%j', (key, value) => {
    const result = customerListQuerySchema.safeParse({ [key]: value });
    expect(result.error?.issues[0]?.path).toEqual([key]);
  });

  it('rejects unknown and repeated parameters', () => {
    expect(customerListQuerySchema.safeParse({ sort: 'name' }).success).toBe(false);
    expect(customerListQuerySchema.safeParse({ q: ['a', 'b'] }).success).toBe(false);
  });
});

describe('customerParamsSchema', () => {
  it('requires a UUID', () => {
    expect(customerParamsSchema.safeParse({ customerId: ID }).success).toBe(true);
    expect(customerParamsSchema.safeParse({ customerId: '1' }).success).toBe(false);
  });
});

describe('updateCustomerRequestSchema', () => {
  it('normalizes the email and lets the name be cleared', () => {
    expect(updateCustomerRequestSchema.parse({ email: ' Ada@Example.COM ', name: null })).toEqual({
      email: 'ada@example.com',
      name: null,
    });
  });

  it.each([
    {},
    { email: 'bad' },
    { name: '' },
    { name: 'x'.repeat(101) },
    { id: ID },
    { organizationId: ID },
  ])('rejects %j', (body) => {
    expect(updateCustomerRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('customer:update permission', () => {
  it('is granted to every role, because keeping contact details right is agent work', () => {
    for (const role of ['OWNER', 'ADMIN', 'AGENT'] as const) {
      expect(hasPermission(role, 'customer:update')).toBe(true);
    }
  });
});

describe('ticket list customer filter', () => {
  it('accepts a customer ID and rejects anything else', () => {
    expect(ticketListQuerySchema.parse({ customer: ID }).customer).toBe(ID);
    expect(ticketListQuerySchema.safeParse({ customer: 'ada@example.com' }).success).toBe(false);
  });
});

describe('team contracts', () => {
  it('trims names and rejects blank, long or extra fields', () => {
    expect(createTeamRequestSchema.parse({ name: '  Billing ' })).toEqual({ name: 'Billing' });
    for (const body of [
      { name: ' ' },
      { name: 'x'.repeat(61) },
      { name: 'A', organizationId: ID },
    ]) {
      expect(createTeamRequestSchema.safeParse(body).success).toBe(false);
      expect(updateTeamRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it('validates both IDs of a membership route', () => {
    expect(teamMemberParamsSchema.safeParse({ teamId: ID, userId: ID }).success).toBe(true);
    expect(teamMemberParamsSchema.safeParse({ teamId: ID, userId: 'me' }).success).toBe(false);
  });
});

describe('tag contracts', () => {
  it('defaults the color to none and accepts palette names only', () => {
    expect(createTagRequestSchema.parse({ name: ' refund ' })).toEqual({
      name: 'refund',
      color: null,
    });
    for (const color of TAG_COLORS) {
      expect(createTagRequestSchema.parse({ name: 'a', color }).color).toBe(color);
    }
    expect(createTagRequestSchema.safeParse({ name: 'a', color: '#ff0000' }).success).toBe(false);
  });

  it.each([{ name: '' }, { name: 'x'.repeat(41) }, { name: 'a,b' }, { name: 'a', ticketCount: 3 }])(
    'rejects %j',
    (body) => {
      expect(createTagRequestSchema.safeParse(body).success).toBe(false);
    },
  );

  it('requires a change on update', () => {
    expect(updateTagRequestSchema.safeParse({}).success).toBe(false);
    expect(updateTagRequestSchema.parse({ color: null })).toEqual({ color: null });
  });
});

describe('searchQuerySchema', () => {
  it('trims the query', () => {
    expect(searchQuerySchema.parse({ q: '  invoice  ' })).toEqual({ q: 'invoice' });
  });

  it.each([
    {},
    { q: '' },
    { q: '  ' },
    { q: 'x'.repeat(SEARCH_QUERY_MAX_LENGTH + 1) },
    { q: ['a', 'b'] },
    { q: 'a', limit: '50' },
  ])('rejects %j', (query) => {
    expect(searchQuerySchema.safeParse(query).success).toBe(false);
  });
});
