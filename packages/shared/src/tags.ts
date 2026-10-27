import { z } from 'zod';
import { ticketTagSchema } from './tickets.ts';

/** Tag colors are palette names, which the web app maps onto theme tokens. */
export const TAG_COLORS = ['violet', 'red', 'blue', 'green', 'amber'] as const;
export const tagColorSchema = z.enum(TAG_COLORS, { error: 'Pick one of the tag colors' });
export type TagColor = z.infer<typeof tagColorSchema>;

/** A tag with how many of the organization's tickets carry it. */
export const tagSchema = ticketTagSchema.extend({ ticketCount: z.int().nonnegative() });
export type Tag = z.infer<typeof tagSchema>;

/** `GET /api/v1/tags`, ordered by name. */
export const tagListResponseSchema = z.object({ data: z.array(tagSchema) });
export type TagListResponse = z.infer<typeof tagListResponseSchema>;

/**
 * Names are unique per organization regardless of case ("VIP" and "vip" are one tag).
 * Commas are reserved because tags appear in comma-separated lists.
 */
const tagNameSchema = z
  .string({ error: 'Enter a tag name' })
  .trim()
  .min(1, 'Enter a tag name')
  .max(40, 'Tag names can be at most 40 characters')
  .refine((name) => !name.includes(','), { error: 'Tag names can’t contain commas' });

export const createTagRequestSchema = z.strictObject({
  name: tagNameSchema,
  color: tagColorSchema.nullable().default(null),
});
export type CreateTagRequest = z.input<typeof createTagRequestSchema>;
export type CreateTagInput = z.output<typeof createTagRequestSchema>;

export const updateTagRequestSchema = z
  .strictObject({
    name: tagNameSchema.optional(),
    color: tagColorSchema.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { error: 'Change at least one field' });
export type UpdateTagRequest = z.input<typeof updateTagRequestSchema>;

export const tagParamsSchema = z.object({ tagId: z.uuid({ error: 'Must be a tag ID' }) });
