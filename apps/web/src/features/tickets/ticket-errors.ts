import { describeAuthError } from '@/features/auth/form-helpers';
import { ApiError } from '@/lib/api-client';

/** A user-facing sentence for a failed ticket request. Never echoes server internals. */
export function describeTicketError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      // Written for people: the lifecycle explains what to do instead.
      case 'INVALID_STATUS_TRANSITION':
      case 'TICKET_CLOSED':
        return error.message;
      case 'VALIDATION_FAILED':
        return error.fieldErrors[0]?.message ?? 'Some details need fixing.';
      case 'NOT_FOUND':
        return 'This ticket no longer exists in this organization.';
      case 'FORBIDDEN':
        return 'Your role in this organization doesn’t allow this change.';
    }
  }
  return describeAuthError(error);
}
