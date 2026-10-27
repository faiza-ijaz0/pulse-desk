import { z } from 'zod';
import { decodeCursor, encodeCursor } from './cursor.ts';
import { searchTextSchema } from './search-text.ts';
import { customerEmailSchema } from './tickets.ts';

export const CUSTOMER_LIST_DEFAULT_LIMIT = 25;
export const CUSTOMER_LIST_MAX_LIMIT = 100;

/** A customer of the active organization. Counts cover their tickets in that organization. */
export const customerSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  email: z.string(),
  createdAt: z.iso.datetime(),
  ticketCount: z.int().nonnegative(),
  /** Tickets still being worked: open, pending or on hold. */
  activeTicketCount: z.int().nonnegative(),
});
export type Customer = z.infer<typeof customerSchema>;

export const customerListResponseSchema = z.object({
  data: z.array(customerSchema),
  nextCursor: z.string().nullable(),
});
export type CustomerListResponse = z.infer<typeof customerListResponseSchema>;

/** Customers are listed by email, which is unique per organization: a total order. */
export type CustomerCursor = { email: string };

const MAX_CURSOR_LENGTH = 500;
const cursorPayloadSchema = z.strictObject({ e: z.string().min(1).max(254) });

export function encodeCustomerCursor(cursor: CustomerCursor): string {
  return encodeCursor({ e: cursor.email });
}

export function decodeCustomerCursor(value: string): CustomerCursor | null {
  const payload = decodeCursor(value, cursorPayloadSchema, MAX_CURSOR_LENGTH);
  return payload && { email: payload.e };
}

/** `GET /api/v1/customers`. `q` matches name or email, case-insensitively. */
export const customerListQuerySchema = z.strictObject({
  q: searchTextSchema.optional(),
  limit: z
    .string({ error: 'Must be a single value' })
    .regex(/^\d{1,3}$/, { error: `Must be a whole number from 1 to ${CUSTOMER_LIST_MAX_LIMIT}` })
    .transform(Number)
    .pipe(
      z
        .int()
        .min(1, { error: 'Must be at least 1' })
        .max(CUSTOMER_LIST_MAX_LIMIT, { error: `Must be at most ${CUSTOMER_LIST_MAX_LIMIT}` }),
    )
    .default(CUSTOMER_LIST_DEFAULT_LIMIT),
  cursor: z
    .string({ error: 'Must be a single value' })
    .transform((value, ctx) => {
      const cursor = decodeCustomerCursor(value);
      if (cursor === null) {
        ctx.addIssue({ code: 'custom', message: 'Invalid cursor' });
        return z.NEVER;
      }
      return cursor;
    })
    .optional(),
});
export type CustomerListQuery = z.output<typeof customerListQuerySchema>;

export const customerParamsSchema = z.object({
  customerId: z.uuid({ error: 'Must be a customer ID' }),
});

/**
 * `PATCH /api/v1/customers/:customerId`. `name: null` clears the name. The email stays
 * unique within the organization (409 if another customer has it).
 */
export const updateCustomerRequestSchema = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1, 'Enter a name, or clear it')
      .max(100, 'Names can be at most 100 characters')
      .nullable()
      .optional(),
    email: customerEmailSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { error: 'Change at least one field' });
export type UpdateCustomerRequest = z.input<typeof updateCustomerRequestSchema>;
export type UpdateCustomerInput = z.output<typeof updateCustomerRequestSchema>;
