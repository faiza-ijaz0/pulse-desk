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
const booleanString = z
  .enum(['true', 'false'], { error: 'must be "true" or "false"' })
  .transform((value) => value === 'true');

/** The value shipped in .env.example. Accepted only in development. */
export const PLACEHOLDER_SESSION_SECRET = 'replace-me-with-a-random-32-plus-character-value';

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    APP_VERSION: z.string().trim().min(1).default('0.0.0-dev'),

    API_HOST: z.string().trim().min(1).default('127.0.0.1'),
    API_PORT: port.default(4000),
    WEB_ORIGIN: originList,
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

    DATABASE_URL: z
      .string()
      .trim()
      .regex(/^postgres(ql)?:\/\//, 'must be a postgresql:// connection URL'),

    SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
    // RFC 6265 cookie-name token characters only.
    SESSION_COOKIE_NAME: z
      .string()
      .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, 'must be a valid cookie name')
      .default('pd_sid'),
    SESSION_COOKIE_SECURE: booleanString.default(false),
    SESSION_IDLE_TIMEOUT_MINUTES: positiveInt.max(60 * 24 * 30).default(720),
    SESSION_ABSOLUTE_TIMEOUT_DAYS: positiveInt.max(90).default(14),

    // Shared with the reverse proxy (Vercel), which sends it on every request it forwards.
    // When set, everything except GET /health requires it. Required in production.
    // The character set also rejects an unexpanded `$PROXY_SHARED_SECRET` placeholder.
    PROXY_SHARED_SECRET: z
      .string()
      .min(32, 'must be at least 32 characters')
      .regex(/^[A-Za-z0-9_-]+$/, 'must contain only letters, digits, "-" and "_" (e.g. base64url)')
      .optional(),

    RATE_LIMIT_GLOBAL_PER_MINUTE: positiveInt.default(300),
    RATE_LIMIT_AUTH_PER_15_MINUTES: positiveInt.default(10),
    SHUTDOWN_TIMEOUT_MS: positiveInt.default(10_000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'development' && env.SESSION_SECRET === PLACEHOLDER_SESSION_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_SECRET'],
        message: 'must be replaced with a random value outside development',
      });
    }
    // Browsers silently drop __Host-/__Secure- cookies that lack the Secure flag.
    if (/^__(Host|Secure)-/.test(env.SESSION_COOKIE_NAME) && !env.SESSION_COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_COOKIE_SECURE'],
        message: 'must be true when SESSION_COOKIE_NAME uses the __Host- or __Secure- prefix',
      });
    }
    if (env.PROXY_SHARED_SECRET !== undefined && env.PROXY_SHARED_SECRET === env.SESSION_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['PROXY_SHARED_SECRET'],
        message: 'must be independent of SESSION_SECRET',
      });
    }
    if (env.NODE_ENV === 'production') {
      // Fail closed: without it, anyone who finds the API host could bypass the proxy.
      if (env.PROXY_SHARED_SECRET === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['PROXY_SHARED_SECRET'],
          message: 'is required in production',
        });
      }
      if (!env.SESSION_COOKIE_SECURE) {
        ctx.addIssue({
          code: 'custom',
          path: ['SESSION_COOKIE_SECURE'],
          message: 'must be true in production',
        });
      }
      // __Host- pins the cookie to this exact host, over HTTPS, for every path.
      if (!env.SESSION_COOKIE_NAME.startsWith('__Host-')) {
        ctx.addIssue({
          code: 'custom',
          path: ['SESSION_COOKIE_NAME'],
          message: 'must use the __Host- prefix in production (e.g. __Host-pd_sid)',
        });
      }
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
