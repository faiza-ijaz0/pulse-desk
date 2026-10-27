import {
  MESSAGE_BODY_MAX_LENGTH,
  TICKET_PRIORITIES,
  TICKET_SUBJECT_MAX_LENGTH,
  createTicketRequestSchema,
  type TicketPriority,
} from '@pulsedesk/shared';
import { Plus } from 'lucide-react';
import { useRef, useState, type SubmitEvent } from 'react';
import { useNavigate } from 'react-router';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { NativeSelect } from '@/components/ui/select';
import { focusFirstInvalid } from '@/features/auth/form-helpers';
import { ApiError, fieldErrorsByName } from '@/lib/api-client';
import { useCreateTicket } from './api';
import { PRIORITY_LABELS } from './ticket-badges';
import { describeTicketError } from './ticket-errors';

const EMPTY = {
  email: '',
  name: '',
  subject: '',
  message: '',
  priority: 'NORMAL' as TicketPriority,
};
type Values = typeof EMPTY;

/** Errors keyed by full field path (`customer.email`), as the API reports them. */
function errorsByPath(error: z.ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) result[issue.path.join('.')] ??= issue.message;
  return result;
}

function toRequest(values: Values) {
  return {
    subject: values.subject,
    customer: { email: values.email, ...(values.name.trim() && { name: values.name }) },
    message: values.message,
    priority: values.priority,
  };
}

/**
 * Opens a ticket on a customer's behalf, e.g. after a phone call. The message becomes the
 * customer's first message; the customer is matched by email or created.
 */
export function NewTicketDialog() {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const create = useCreateTicket();
  const navigate = useNavigate();

  function reset() {
    setValues(EMPTY);
    setErrors({});
    setSubmitted(false);
    create.reset();
  }

  function update<Key extends keyof Values>(name: Key, value: Values[Key]) {
    const next = { ...values, [name]: value };
    setValues(next);
    if (submitted) {
      const result = createTicketRequestSchema.safeParse(toRequest(next));
      setErrors(result.success ? {} : errorsByPath(result.error));
    }
  }

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    const result = createTicketRequestSchema.safeParse(toRequest(values));
    if (!result.success) {
      setErrors(errorsByPath(result.error));
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    setErrors({});
    create.mutate(result.data, {
      onSuccess: (detail) => {
        setOpen(false);
        reset();
        void navigate(`/tickets/${detail.ticket.number}`);
      },
      onError: (error) => {
        if (error instanceof ApiError && error.fieldErrors.length > 0) {
          setErrors(fieldErrorsByName(error));
          requestAnimationFrame(() => focusFirstInvalid(formRef.current));
        }
      },
    });
  }

  const pending = create.isPending;
  const showFailure =
    create.isError && !(create.error instanceof ApiError && create.error.fieldErrors.length > 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Don't drop a request in flight; a closed dialog starts fresh next time.
        if (pending) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus aria-hidden="true" />
          New ticket
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New ticket</DialogTitle>
          <DialogDescription>
            Log a request on a customer’s behalf. Their message opens the conversation.
          </DialogDescription>
        </DialogHeader>
        <form
          ref={formRef}
          noValidate
          onSubmit={onSubmit}
          className="grid gap-4"
          aria-busy={pending}
        >
          {showFailure && (
            <Alert tone="danger" title="Couldn’t create the ticket">
              {describeTicketError(create.error)}
            </Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Customer email"
              error={errors['customer.email']}
              required
              className="content-start"
            >
              {(control) => (
                <Input
                  {...control}
                  type="email"
                  inputMode="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={values.email}
                  onChange={(e) => update('email', e.target.value)}
                  disabled={pending}
                />
              )}
            </Field>
            <Field label="Customer name" error={errors['customer.name']} className="content-start">
              {(control) => (
                <Input
                  {...control}
                  value={values.name}
                  onChange={(e) => update('name', e.target.value)}
                  disabled={pending}
                />
              )}
            </Field>
          </div>
          <Field label="Subject" error={errors.subject} required>
            {(control) => (
              <Input
                {...control}
                maxLength={TICKET_SUBJECT_MAX_LENGTH}
                value={values.subject}
                onChange={(e) => update('subject', e.target.value)}
                disabled={pending}
              />
            )}
          </Field>
          <Field
            label="Message"
            description="What the customer asked, in their words."
            error={errors.message}
            required
          >
            {(control) => (
              <Textarea
                {...control}
                rows={5}
                maxLength={MESSAGE_BODY_MAX_LENGTH}
                value={values.message}
                onChange={(e) => update('message', e.target.value)}
                disabled={pending}
              />
            )}
          </Field>
          <Field label="Priority" error={errors.priority} className="sm:max-w-48">
            {(control) => (
              <NativeSelect
                {...control}
                value={values.priority}
                onChange={(e) => {
                  const priority = TICKET_PRIORITIES.find((p) => p === e.target.value);
                  if (priority) update('priority', priority);
                }}
              >
                {[...TICKET_PRIORITIES].reverse().map((priority) => (
                  <option key={priority} value={priority}>
                    {PRIORITY_LABELS[priority]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setOpen(false);
                reset();
              }}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Create ticket
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
