import { pino, type DestinationStream, type Logger } from 'pino';

/**
 * Paths removed from every log line. Covers credentials in headers, cookies set by the
 * API, and common secret-bearing body fields. Keep this list conservative: it is far
 * cheaper to redact too much than to leak a session token into log storage.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.secret',
  '*.sessionToken',
];

export type LoggerOptions = {
  level: string;
  version: string;
  destination?: DestinationStream;
};

export function createLogger({ level, version, destination }: LoggerOptions): Logger {
  return pino(
    {
      level,
      base: { service: 'pulsedesk-api', version },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      formatters: { level: (label) => ({ level: label }) },
    },
    destination,
  );
}

export type { Logger };
