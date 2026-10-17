import { z } from 'zod';

/**
 * Stable, machine-readable error codes. Clients branch on `code`, never on `title`
 * or `detail`, so these values are part of the public API contract.
 */
export const ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'CSRF_ORIGIN_MISMATCH',
  'NOT_FOUND',
  'ROUTE_NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const fieldErrorSchema = z.object({
  /** Dot-separated path to the invalid field, e.g. `body.email`. */
  path: z.string(),
  message: z.string(),
});
export type FieldError = z.infer<typeof fieldErrorSchema>;

/**
 * RFC 9457 problem details, extended with `code`, `requestId` and optional field errors.
 * Served with `Content-Type: application/problem+json`.
 */
export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  code: errorCodeSchema,
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string(),
  errors: z.array(fieldErrorSchema).optional(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export function isProblemDetails(value: unknown): value is ProblemDetails {
  return problemDetailsSchema.safeParse(value).success;
}
