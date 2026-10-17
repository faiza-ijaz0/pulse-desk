import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const originList = z
  .string()
  .trim()
  .min(1, 'must list at least one origin')
  .transform((value, ctx) => {
    const origins: string[] = [];
    for (const raw of value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        ctx.addIssue({ code: 'custom', message: `"${raw}" is not a valid URL` });
        return z.NEVER;
      }
      if (url.origin !== raw.replace(/\/$/, '')) {
        ctx.addIssue({
          code: 'custom',
          message: `"${raw}" must be a bare origin (scheme://host[:port])`,
        });
        return z.NEVER;
      }
      origins.push(url.origin);
    }
    return origins;
  });

const port = z.coerce.number().int().min(1).max(65_535);
const positiveInt = z.coerce.number().int().positive();

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    APP_VERSION: z.string().trim().min(1).default('0.0.0-dev'),

    API_HOST: z.string().trim().min(1).default('127.0.0.1'),
    API_PORT: port.default(4000),
    WEB_ORIGIN: originList,
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

    RATE_LIMIT_GLOBAL_PER_MINUTE: positiveInt.default(300),
    SHUTDOWN_TIMEOUT_MS: positiveInt.default(10_000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      for (const origin of env.WEB_ORIGIN) {
        if (!origin.startsWith('https://')) {
          ctx.addIssue({
            code: 'custom',
            path: ['WEB_ORIGIN'],
            message: `must use https in production (got ${origin})`,
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export type EnvResult = { ok: true; env: Env } | { ok: false; problems: string[] };

/**
 * Validates configuration. Problems name the variable and the rule that failed but never
 * echo the supplied value, so secrets cannot leak into startup logs.
 */
export function parseEnv(source: Record<string, string | undefined>): EnvResult {
  // Treat empty strings as unset so `FOO=` in .env falls back to the default.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ''),
  );
  const result = envSchema.safeParse(cleaned);
  if (result.success) return { ok: true, env: result.data };

  const problems = result.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    // Zod 4 omits `issue.input` unless `reportInput` is on (which would risk echoing
    // secrets), so decide "missing" from the source rather than from the issue.
    const missing = issue.path.length === 1 && !(String(issue.path[0]) in cleaned);
    return `${key} ${missing ? 'is required' : issue.message}`;
  });
  return { ok: false, problems };
}
