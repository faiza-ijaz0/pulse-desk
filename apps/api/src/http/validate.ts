import type { z } from 'zod';
import { ValidationError } from './errors.ts';

type Location = 'body' | 'query' | 'params';

/**
 * Parses one part of a request against a Zod schema. Returns the typed, stripped value or
 * throws a ValidationError whose field paths are prefixed with the request location
 * (e.g. `body.email`), matching the shared ProblemDetails contract.
 */
export function parseRequest<Schema extends z.ZodType>(
  location: Location,
  schema: Schema,
  input: unknown,
): z.infer<Schema> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  throw new ValidationError(
    result.error.issues.map((issue) => ({
      path: [location, ...issue.path.map(String)].join('.'),
      message: issue.message,
    })),
  );
}
