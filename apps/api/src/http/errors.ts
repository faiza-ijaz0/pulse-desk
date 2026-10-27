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

/** One message for unknown email and wrong password alike, so login can't enumerate accounts. */
export class InvalidCredentialsError extends AppError {
  constructor() {
    super({
      status: 401,
      code: 'INVALID_CREDENTIALS',
      title: 'Invalid credentials',
      detail: 'Incorrect email or password.',
    });
  }
}

export class NoActiveOrganizationError extends AppError {
  constructor() {
    super({
      status: 403,
      code: 'NO_ACTIVE_ORGANIZATION',
      title: 'No active organization',
      detail: 'Choose an organization you belong to before continuing.',
    });
  }
}

export class EmailTakenError extends AppError {
  constructor() {
    super({
      status: 409,
      code: 'EMAIL_TAKEN',
      title: 'Email already registered',
      detail: 'An account with this email already exists. Sign in instead.',
      fieldErrors: [{ path: 'body.email', message: 'An account with this email already exists' }],
    });
  }
}

export class LastOwnerError extends AppError {
  constructor() {
    super({
      status: 409,
      code: 'LAST_OWNER',
      title: 'Organization needs an owner',
      detail: 'Every organization must keep at least one owner. Promote another member first.',
    });
  }
}

export class InvalidStatusTransitionError extends AppError {
  constructor(detail: string) {
    super({
      status: 409,
      code: 'INVALID_STATUS_TRANSITION',
      title: 'Status change not allowed',
      detail,
    });
  }
}

export class TicketClosedError extends AppError {
  constructor() {
    super({
      status: 409,
      code: 'TICKET_CLOSED',
      title: 'Ticket is closed',
      detail:
        'Closed tickets are read-only. A new message from the customer starts a follow-up ticket.',
    });
  }
}
