import { Eye, EyeOff } from 'lucide-react';
import { useState, type ComponentProps } from 'react';
import type { z } from 'zod';
import { Input } from '@/components/ui/input';
import { ApiError, ApiUnavailableError, GATEWAY_STATUSES } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/** First validation message per top-level field, for Field's `error` prop. */
export function issuesByField(error: z.ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    result[key] ??= issue.message;
  }
  return result;
}

/** Moves focus to the first invalid control so keyboard and screen-reader users land on it. */
export function focusFirstInvalid(form: HTMLFormElement | null): void {
  form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
}

/** A user-facing sentence for a failed auth request. Never echoes server internals. */
export function describeAuthError(error: unknown): string {
  if (error instanceof ApiUnavailableError) {
    // A gateway answered for the API: most often the server is still starting up.
    // Forms are never resubmitted automatically, so the user decides when to retry.
    if (error.status !== undefined && GATEWAY_STATUSES.has(error.status)) {
      return 'PulseDesk is starting up or briefly unavailable. Wait a moment, then try again.';
    }
    return 'We couldn’t reach PulseDesk. Check your connection and try again.';
  }
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'INVALID_CREDENTIALS':
        return 'Incorrect email or password.';
      case 'RATE_LIMITED':
        return 'Too many attempts. Wait a few minutes, then try again.';
      case 'CSRF_ORIGIN_MISMATCH':
        return 'This page isn’t allowed to send that request. Reload it and try again.';
      case 'VALIDATION_FAILED':
        return 'Some details need fixing. Check the highlighted fields.';
      // The API answered, but a dependency (the database) is down: not the user's fault,
      // and not worth a support reference.
      case 'SERVICE_UNAVAILABLE':
        return 'PulseDesk is temporarily unavailable. Please try again in a few minutes.';
      default:
        return `Something went wrong (reference ${error.requestId}). Please try again.`;
    }
  }
  return 'Something went wrong. Please try again.';
}

/** Password input with a show/hide toggle. Visibility resets on every mount. */
export function PasswordInput({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={visible ? 'text' : 'password'} className={cn('pr-10', className)} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-subtle-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/20 focus-visible:outline-none"
      >
        {visible ? (
          <EyeOff className="size-4" aria-hidden="true" />
        ) : (
          <Eye className="size-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
