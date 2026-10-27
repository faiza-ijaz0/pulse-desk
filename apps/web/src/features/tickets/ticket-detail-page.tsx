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
import { TicketPriorityLabel, TicketStatusBadge } from './ticket-badges';
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

function ThreadMessage({ message }: { message: ThreadItem }) {
  const internal = message.visibility === 'INTERNAL';
  const name = authorName(message.author);
  return (
    <li
      className={cn(
        'rounded-lg border px-4 py-3',
        internal
          ? 'border-warning/35 bg-warning-subtle/60'
          : message.author.type === 'CUSTOMER'
            ? 'border-border bg-surface'
            : 'border-border bg-surface-sunken/50',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {message.author.type === 'SYSTEM' ? null : (
          <Avatar name={name} size="sm" className="ring-0" />
        )}
        <span className="text-sm font-medium">{name}</span>
        {message.author.type === 'CUSTOMER' && (
          <span className="text-xs text-muted-foreground">Customer</span>
        )}
        {internal && (
          <span className="inline-flex items-center gap-1 rounded-sm bg-warning-subtle px-1.5 text-xs font-medium text-warning-foreground ring-1 ring-warning/25 ring-inset">
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
      <div className="mb-6 min-w-0">
        <p className="font-mono text-xs text-muted-foreground">Ticket #{ticket.number}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight break-words">{ticket.subject}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
          <TicketStatusBadge status={ticket.status} />
          <TicketPriorityLabel priority={ticket.priority} />
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
