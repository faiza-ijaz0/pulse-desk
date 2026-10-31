import {
  MESSAGE_BODY_MAX_LENGTH,
  createMessageRequestSchema,
  type MessageVisibility,
} from '@pulsedesk/shared';
import { Lock, MessageSquare } from 'lucide-react';
import { useId, useState, type KeyboardEvent, type SubmitEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Kbd } from '@/components/ui/misc';
import { cn } from '@/lib/utils';
import { useAddMessage } from './api';
import { describeTicketError } from './ticket-errors';

const MODES: Record<
  MessageVisibility,
  { tab: string; form: string; field: string; submit: string; hint: string }
> = {
  PUBLIC: {
    tab: 'Reply',
    form: 'Reply to the customer',
    field: 'Reply',
    submit: 'Send reply',
    hint: 'Added to the conversation the customer sees. It isn’t sent by email yet — PulseDesk has no email delivery connected.',
  },
  INTERNAL: {
    tab: 'Internal note',
    form: 'Add an internal note',
    field: 'Note',
    submit: 'Add note',
    hint: 'Only your team can see internal notes. The customer never does.',
  },
};

/**
 * Writes a public reply or an internal note. Drafts are kept per mode, survive a failed
 * send, and clear only once the server has saved the message. Ctrl/⌘+Enter sends.
 */
export function TicketComposer({ number }: { number: number }) {
  const addMessage = useAddMessage(number);
  const [mode, setMode] = useState<MessageVisibility>('PUBLIC');
  const [drafts, setDrafts] = useState<Record<MessageVisibility, string>>({
    PUBLIC: '',
    INTERNAL: '',
  });
  const [error, setError] = useState<string>();
  const [announcement, setAnnouncement] = useState('');
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const labels = MODES[mode];
  const draft = drafts[mode];
  const internal = mode === 'INTERNAL';

  function send() {
    const parsed = createMessageRequestSchema.safeParse({ body: draft, visibility: mode });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Write a message');
      return;
    }
    setError(undefined);
    const sentMode = mode;
    addMessage.mutate(parsed.data, {
      onSuccess: () => {
        setDrafts((current) => ({ ...current, [sentMode]: '' }));
        setAnnouncement(sentMode === 'INTERNAL' ? 'Note added' : 'Reply added');
      },
    });
  }

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    send();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !addMessage.isPending) {
      event.preventDefault();
      send();
    }
  }

  const failure = addMessage.isError ? describeTicketError(addMessage.error) : undefined;
  // Like Field: an error replaces the hint as the description, so it is what gets read.
  const describedBy = error ? errorId : hintId;

  return (
    <div className="grid gap-2">
      <div
        role="radiogroup"
        aria-label="Message type"
        className="inline-flex w-fit rounded-lg border border-border bg-surface-sunken p-0.5"
      >
        {(Object.keys(MODES) as MessageVisibility[]).map((value) => {
          const Icon = value === 'INTERNAL' ? Lock : MessageSquare;
          return (
            <label
              key={value}
              className={cn(
                'inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium transition-colors',
                'has-focus-visible:ring-2 has-focus-visible:ring-ring',
                mode === value
                  ? value === 'INTERNAL'
                    ? 'bg-warning-subtle text-warning-foreground shadow-xs'
                    : 'bg-surface text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <input
                type="radio"
                name={`${fieldId}-mode`}
                value={value}
                checked={mode === value}
                onChange={() => {
                  setMode(value);
                  setError(undefined);
                  addMessage.reset();
                }}
                className="sr-only"
              />
              <Icon className="size-3.5" aria-hidden="true" />
              {MODES[value].tab}
            </label>
          );
        })}
      </div>

      <form
        aria-label={labels.form}
        onSubmit={onSubmit}
        noValidate
        className={cn(
          'grid gap-2 rounded-xl border p-3 transition-[border-color,box-shadow] focus-within:shadow-[var(--highlight),var(--elevation-md)]',
          internal
            ? 'border-dashed border-warning/45 bg-warning-subtle/45'
            : 'border-border bg-surface shadow-[var(--highlight),var(--elevation-sm)] focus-within:border-accent/40',
        )}
      >
        <label htmlFor={fieldId} className="sr-only">
          {labels.field}
        </label>
        <Textarea
          id={fieldId}
          value={draft}
          onChange={(event) => {
            const value = event.target.value;
            setDrafts((current) => ({ ...current, [mode]: value }));
            if (error) setError(undefined);
          }}
          onKeyDown={onKeyDown}
          placeholder={internal ? 'Write a note for your team…' : 'Write a reply…'}
          rows={4}
          maxLength={MESSAGE_BODY_MAX_LENGTH}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className="min-h-24 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
        />
        {error && (
          <p id={errorId} className="text-xs font-medium text-danger-foreground">
            {error}
          </p>
        )}
        {failure && (
          <p
            role="alert"
            className="rounded-md border border-danger/25 bg-danger-subtle px-3 py-2 text-sm text-danger-foreground"
          >
            {failure}
          </p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <p id={hintId} className="text-xs text-muted-foreground sm:max-w-md">
            {labels.hint}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden text-xs text-subtle-foreground sm:inline" aria-hidden="true">
              <Kbd>Ctrl</Kbd> <Kbd>Enter</Kbd>
            </span>
            <Button type="submit" size="sm" loading={addMessage.isPending}>
              {labels.submit}
            </Button>
          </div>
        </div>
      </form>
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
