import { z } from 'zod';

/** Response body of `GET /health` (liveness only — it does not check dependencies). */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('pulsedesk-api'),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/**
 * Body of `GET /health/ready`: whether this instance can serve real traffic. Answered with
 * 200 when ready and 503 otherwise; it never includes error details.
 */
export const readinessResponseSchema = z.object({
  status: z.enum(['ready', 'unavailable']),
  checks: z.object({ database: z.enum(['ok', 'unavailable']) }),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
