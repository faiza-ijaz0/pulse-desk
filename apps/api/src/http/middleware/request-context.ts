import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pinoHttp } from 'pino-http';
import type { Logger } from '../../lib/logger.ts';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Inbound IDs are only trusted when short and URL-safe, so they cannot inject into logs. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function resolveRequestId(inbound: string | string[] | undefined): string {
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  return candidate !== undefined && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
}

/**
 * Assigns `req.id`, echoes it as `X-Request-Id`, and attaches a child logger (`req.log`)
 * that stamps every line with that ID. Logs one line per completed request.
 */
export function requestContext(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId(req: IncomingMessage, res: ServerResponse) {
      const id = resolveRequestId(req.headers['x-request-id']);
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
    customAttributeKeys: { reqId: 'requestId' },
    // Bind only `requestId` (not the whole request) to `req.log`, so every line a handler
    // logs carries a flat, searchable request ID.
    quietReqLogger: true,
    customLogLevel(_req, res, error) {
      if (error || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    // Liveness probes would otherwise dominate the logs.
    autoLogging: { ignore: (req) => req.url === '/health' },
    serializers: {
      req: (req: {
        id: unknown;
        method: string;
        url: string;
        headers: Record<string, unknown>;
      }) => ({
        id: req.id,
        method: req.method,
        url: req.url,
        headers: req.headers,
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  });
}
