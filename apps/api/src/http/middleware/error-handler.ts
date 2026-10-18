import { databaseUnavailableCode, prismaErrorCode } from '@pulsedesk/db';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../errors.ts';
import { sendProblem } from '../problem.ts';

export const notFoundHandler: RequestHandler = (req, res) => {
  sendProblem(req, res, {
    status: 404,
    code: 'ROUTE_NOT_FOUND',
    title: 'Not found',
    detail: `No route matches ${req.method} ${req.path}.`,
  });
};

/** Errors raised by express.json() (body-parser) carry a `type` and an HTTP status. */
type BodyParserError = Error & { type: string; status: number };

function isBodyParserError(error: unknown): error is BodyParserError {
  return (
    error instanceof Error &&
    typeof (error as Partial<BodyParserError>).type === 'string' &&
    typeof (error as Partial<BodyParserError>).status === 'number'
  );
}

/**
 * The one place errors become HTTP responses. Expected errors (AppError, malformed
 * bodies) map to their status; anything else is logged with its stack and returned as
 * a generic 500 so internals never reach the client.
 */
export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof AppError) {
    sendProblem(req, res, {
      status: error.status,
      code: error.code,
      title: error.title,
      detail: error.detail,
      errors: error.fieldErrors,
    });
    return;
  }

  if (isBodyParserError(error)) {
    if (error.type === 'entity.too.large') {
      sendProblem(req, res, {
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        title: 'Payload too large',
        detail: 'The request body exceeds the size limit.',
      });
      return;
    }
    if (error.status >= 400 && error.status < 500) {
      sendProblem(req, res, {
        status: 400,
        code: 'BAD_REQUEST',
        title: 'Bad request',
        detail:
          error.type === 'entity.parse.failed'
            ? 'The request body is not valid JSON.'
            : 'The request body could not be read.',
      });
      return;
    }
  }

  // An outage, not a bug: say so (503) without detail, and log the code operators need.
  // Logs carry the request ID (bound to req.log) and the Prisma error code, never the
  // connection string; Prisma's messages name the user and host but not the password.
  const unavailable = databaseUnavailableCode(error);
  if (unavailable !== undefined) {
    req.log.error({ err: error, errorCode: unavailable }, 'Database unavailable');
    res.set('Retry-After', '30');
    sendProblem(req, res, {
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      title: 'Service temporarily unavailable',
      detail: 'PulseDesk can’t complete this request right now. Try again in a few minutes.',
    });
    return;
  }

  req.log.error(
    { err: error, errorCode: prismaErrorCode(error) ?? 'UNHANDLED' },
    'Unhandled error while processing request',
  );
  sendProblem(req, res, {
    status: 500,
    code: 'INTERNAL_ERROR',
    title: 'Internal server error',
    detail: 'An unexpected error occurred. Quote the request ID when contacting support.',
  });
};
