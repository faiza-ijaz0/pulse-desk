import { isProblemDetails, type ErrorCode, type FieldError } from '@pulsedesk/shared';
import type { z } from 'zod';

/** The API answered with an RFC 9457 problem document. Branch on `code`, never on text. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly fieldErrors: FieldError[];
  readonly requestId: string;

  constructor(problem: {
    status: number;
    code: ErrorCode;
    title: string;
    detail?: string | undefined;
    errors?: FieldError[] | undefined;
    requestId: string;
  }) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.status = problem.status;
    this.code = problem.code;
    this.fieldErrors = problem.errors ?? [];
    this.requestId = problem.requestId;
  }
}

/**
 * No PulseDesk API answered: the network failed, or something else (a static host, a
 * misconfigured proxy) replied with a non-API response — e.g. a frontend-only deployment.
 */
export class ApiUnavailableError extends Error {
  /** The HTTP status of the non-API response, if there was a response at all. */
  readonly status: number | undefined;
  /**
   * Likely to clear up on its own: the network failed, a gateway answered 502/503/504
   * (e.g. while a sleeping API host starts), or a host served an interstitial page.
   * A plain 404 is not transient: it means no API is attached to this deployment.
   */
  readonly transient: boolean;

  constructor(reason: string, { status, transient }: { status?: number; transient: boolean }) {
    super(reason);
    this.name = 'ApiUnavailableError';
    this.status = status;
    this.transient = transient;
  }
}

/** Gateway statuses a proxy returns while the upstream is starting or briefly unreachable. */
export const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

type RequestOptions<Schema extends z.ZodType | undefined> = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Validates the success body against the shared contract. Omit for empty (204) responses. */
  schema?: Schema;
  signal?: AbortSignal;
};

/**
 * Calls the PulseDesk API on the page's own origin (the dev server or the hosting layer
 * proxies `/api`), so the HttpOnly session cookie is first-party and sent automatically.
 * No host is configured here and no token is ever read or stored by JavaScript.
 */
export async function apiRequest<Schema extends z.ZodType | undefined = undefined>(
  path: string,
  { method = 'GET', body, schema, signal }: RequestOptions<Schema> = {},
): Promise<Schema extends z.ZodType ? z.infer<Schema> : undefined> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: signal ?? null,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiUnavailableError('The PulseDesk API could not be reached.', { transient: true });
  }

  const isJson = /\bjson\b/i.test(response.headers.get('content-type') ?? '');
  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    if (isProblemDetails(payload)) throw new ApiError(payload);
    throw new ApiUnavailableError(
      `No PulseDesk API responded at ${path} (HTTP ${response.status}).`,
      { status: response.status, transient: GATEWAY_STATUSES.has(response.status) },
    );
  }
  if (schema === undefined) {
    return undefined as Schema extends z.ZodType ? z.infer<Schema> : undefined;
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    // A successful non-JSON page in place of the API is a host's interstitial (e.g. a
    // "service is starting" page), not a contract mismatch, so it is worth retrying.
    throw new ApiUnavailableError(`Unexpected response from ${path}.`, {
      status: response.status,
      transient: !isJson,
    });
  }
  // The conditional return type can't be narrowed through the generic; parsed.data is the
  // schema's output type by construction.
  return parsed.data as Schema extends z.ZodType ? z.infer<Schema> : undefined;
}

/** Server field errors keyed by form field (`body.email` → `email`). */
export function fieldErrorsByName(error: ApiError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const { path, message } of error.fieldErrors) {
    const name = path.replace(/^body\./, '');
    result[name] ??= message;
  }
  return result;
}
