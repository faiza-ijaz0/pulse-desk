import {
  ticketParamsSchema,
  type ConversationMessage,
  type InternalNote,
  type MessageAuthor,
} from '@pulsedesk/shared';
import { ArrowLeft, FileSearch, Lock } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { EmptyState, ErrorState } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, Skeleton } from '@/components/ui/misc';
import { describeAuthError } from '@/features/auth/form-helpers';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useTicketDetail } from './api';
import {
  PRIORITY_STRIPES,
  SlaBadge,
  TicketPriorityLabel,
  TicketStatusBadge,
} from './ticket-badges';
import { TicketComposer } from './ticket-composer';
import { RelativeTime } from './ticket-parts';
import { TicketProperties } from './ticket-properties';
import { TicketTimeline } from './ticket-timeline';

function BackLink() {
  return (
    <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2.5">
      <Link to="/tickets">
        <ArrowLeft aria-hidden="true" />
        All tickets
      </Link>
    </Button>
  );
}

function authorName(author: MessageAuthor): string {
  switch (author.type) {
    case 'AGENT':
      return author.name ?? 'Deleted user';
    case 'CUSTOMER':
      return author.name ?? author.email;
    case 'SYSTEM':
      return 'PulseDesk';
  }
}

type ThreadItem = ConversationMessage | InternalNote;

// Three kinds of message, told apart by more than color: customers on the plain surface,
// your team's replies with a violet tint, internal notes amber, dashed and labelled.
function messageStyle(message: ThreadItem): string {
  if (message.visibility === 'INTERNAL') {
    return 'border-dashed border-warning/45 bg-warning-subtle/70';
  }
  if (message.author.type === 'CUSTOMER') {
    return 'border-border bg-surface shadow-[var(--highlight),var(--elevation-xs)]';
  }
  return 'border-accent/20 bg-accent-subtle/45 sm:ml-8';
}

function ThreadMessage({ message }: { message: ThreadItem }) {
  const internal = message.visibility === 'INTERNAL';
  const name = authorName(message.author);
  return (
    <li className={cn('rounded-xl border px-4 py-3.5', messageStyle(message))}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {message.author.type === 'SYSTEM' ? null : (
          <Avatar name={name} size="sm" className="ring-0" />
        )}
        <span className="text-sm font-medium">{name}</span>
        {message.author.type === 'CUSTOMER' && (
          <span className="rounded-full bg-info-subtle px-1.5 text-2xs font-medium text-info-foreground">
            Customer
          </span>
        )}
        {internal && (
          <span className="inline-flex items-center gap-1 rounded-full bg-warning-subtle px-2 text-xs font-medium text-warning-foreground ring-1 ring-warning/30 ring-inset">
            <Lock className="size-3" aria-hidden="true" />
            Internal note
          </span>
        )}
        <RelativeTime iso={message.createdAt} className="ml-auto text-xs text-muted-foreground" />
      </div>
      {internal && <p className="sr-only">Only visible to your team, never to the customer.</p>}
      <p className="mt-2 text-sm leading-relaxed break-words whitespace-pre-wrap">{message.body}</p>
      {message.editedAt && (
        <p className="mt-1 text-xs text-muted-foreground">
          Edited <RelativeTime iso={message.editedAt} />
        </p>
      )}
    </li>
  );
}

function DetailSkeleton() {
  return (
    <div role="status" aria-label="Loading ticket">
      <Skeleton className="mb-3 h-8 w-28" />
      <Skeleton className="mb-6 h-8 w-2/3" />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid content-start gap-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <Skeleton className="h-80" />
      </div>
    </div>
  );
}

function NotFound() {
  return (
    <EmptyState
      icon={FileSearch}
      title="Ticket not found"
      description="There’s no ticket with this number in your current organization. It may belong to another organization you can switch to."
    >
      <Button asChild variant="secondary" size="sm">
        <Link to="/tickets">
          <ArrowLeft aria-hidden="true" />
          Back to all tickets
        </Link>
      </Button>
    </EmptyState>
  );
}

export function TicketDetailPage() {
  const params = ticketParamsSchema.safeParse(useParams());
  const number = params.success ? params.data.number : undefined;
  const detail = useTicketDetail(number);

  if (number === undefined) return <NotFound />;
  if (detail.isPending) return <DetailSkeleton />;
  if (detail.isError) {
    if (detail.error instanceof ApiError && detail.error.status === 404) return <NotFound />;
    return (
      <>
        <BackLink />
        <ErrorState
          title="Couldn’t load this ticket"
          description={describeAuthError(detail.error)}
          onRetry={() => void detail.refetch()}
          retrying={detail.isRefetching}
        />
      </>
    );
  }

  const { ticket, conversation, internalNotes, timeline } = detail.data;
  // Agents read notes in context, so they are interleaved with the conversation by time —
  // each one marked, and kept separate in the API response.
  const thread: ThreadItem[] = [...conversation, ...internalNotes].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );

  return (
    <>
      <BackLink />
      <div className="relative mb-6 min-w-0 overflow-hidden rounded-2xl border border-border bg-surface px-5 py-5 shadow-[var(--highlight),var(--elevation-sm)] sm:px-6">
        {/* Priority edge (decorative: the priority is written out below). */}
        <span
          aria-hidden="true"
          className={cn('absolute inset-y-0 left-0 w-1', PRIORITY_STRIPES[ticket.priority])}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-16 -right-16 size-56 rounded-full bg-accent/10 blur-3xl"
        />
        <p className="relative font-mono text-xs text-muted-foreground">Ticket #{ticket.number}</p>
        <h1 className="relative mt-1 text-2xl font-semibold tracking-tight break-words">
          {ticket.subject}
        </h1>
        <div className="relative mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
          <TicketStatusBadge status={ticket.status} />
          <TicketPriorityLabel priority={ticket.priority} />
          <SlaBadge status={ticket.sla.status} />
          <span>
            Opened <RelativeTime iso={ticket.createdAt} /> by{' '}
            {ticket.customer.name ?? ticket.customer.email}
          </span>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-labelledby="conversation-title" className="min-w-0">
          <h2 id="conversation-title" className="mb-3 text-base font-semibold">
            Conversation
          </h2>
          {thread.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-sm text-muted-foreground">
              No messages on this ticket yet.
            </p>
          ) : (
            <ol aria-label="Conversation" className="grid gap-3">
              {thread.map((message) => (
                <ThreadMessage key={message.id} message={message} />
              ))}
            </ol>
          )}
          <div className="mt-5">
            {ticket.status === 'CLOSED' ? (
              <p className="flex items-center gap-2 rounded-lg border border-dashed border-border-strong px-4 py-3 text-sm text-muted-foreground">
                <Lock className="size-4 shrink-0" aria-hidden="true" />
                Closed tickets are read-only. A new message from the customer starts a follow-up
                ticket.
              </p>
            ) : (
              <TicketComposer number={ticket.number} />
            )}
          </div>
        </section>

        <aside className="grid content-start gap-5" aria-label="Ticket information">
          <TicketProperties ticket={ticket} />
          <Card aria-labelledby="ticket-activity-title">
            <CardHeader>
              <CardTitle id="ticket-activity-title">Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <TicketTimeline events={timeline} />
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}
