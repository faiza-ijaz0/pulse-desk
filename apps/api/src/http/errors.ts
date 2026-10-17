import type { ErrorCode, FieldError } from '@pulsedesk/shared';

/**
 * Base class for expected, client-facing failures. Services throw these; the central
 * error handler turns them into RFC 9457 problem responses. Anything that is *not* an
 * AppError is treated as a bug and becomes a generic 500.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly title: string;
  readonly detail: string | undefined;
  readonly fieldErrors: FieldError[] | undefined;

  constructor(options: {
    status: number;
    code: ErrorCode;
    title: string;
    detail?: string;
    fieldErrors?: FieldError[];
    cause?: unknown;
  }) {
    super(options.detail ?? options.title, { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status;
    this.code = options.code;
    this.title = options.title;
    this.detail = options.detail;
    this.fieldErrors = options.fieldErrors;
  }
}

export class BadRequestError extends AppError {
  constructor(detail?: string) {
    super({ status: 400, code: 'BAD_REQUEST', title: 'Bad request', ...(detail && { detail }) });
  }
}

export class ValidationError extends AppError {
  constructor(fieldErrors: FieldError[]) {
    super({
      status: 400,
      code: 'VALIDATION_FAILED',
      title: 'Validation failed',
      detail: 'One or more fields are invalid.',
      fieldErrors,
    });
  }
}

export class UnauthenticatedError extends AppError {
  constructor() {
    super({ status: 401, code: 'UNAUTHENTICATED', title: 'Authentication required' });
  }
}

export class ForbiddenError extends AppError {
  constructor(detail?: string) {
    super({ status: 403, code: 'FORBIDDEN', title: 'Forbidden', ...(detail && { detail }) });
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super({ status: 404, code: 'NOT_FOUND', title: 'Not found', detail: `${resource} not found.` });
  }
}

export class ConflictError extends AppError {
  constructor(detail: string) {
    super({ status: 409, code: 'CONFLICT', title: 'Conflict', detail });
  }
}
