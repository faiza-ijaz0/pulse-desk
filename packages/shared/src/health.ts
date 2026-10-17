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
