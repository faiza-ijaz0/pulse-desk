import type { TicketSummary } from '@pulsedesk/shared';
import { Inbox, SearchX } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { EmptyState, ErrorState, PageHeader } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/misc';
import { describeAuthError } from '@/features/auth/form-helpers';
import { useTicketList } from './api';
import { NewTicketDialog } from './new-ticket-dialog';
import {
  filtersFromSearchParams,
  filtersToSearchParams,
  hasActiveFilters,
  type TicketFilters,
} from './filters';
import { TicketPriorityLabel, TicketStatusBadge } from './ticket-badges';
import { TicketFiltersBar } from './ticket-filters';
import { AssigneeLabel, RelativeTime, TagList } from './ticket-parts';

const ROW_GRID =
  'md:grid md:grid-cols-[minmax(0,1fr)_7rem_6rem_10rem_6.5rem] md:items-center md:gap-4';

/** One inbox row; also used for a customer's ticket history. */
export function TicketRow({ ticket }: { ticket: TicketSummary }) {
  return (
    // The subject link stretches over the whole row (after:inset-0), so the row is one
    // click target with one short accessible name, and the rest stays readable text.
    <li className="relative px-4 py-3 transition-colors focus-within:bg-surface-hover/60 hover:bg-surface-hover/60 sm:px-5">
      <div className={ROW_GRID}>
        <div className="min-w-0">
          <Link
            to={`/tickets/${ticket.number}`}
            className="block truncate text-sm font-medium after:absolute after:inset-0 after:rounded-[inherit] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
          >
            <span className="mr-1 font-mono text-xs font-normal text-muted-foreground">
              #{ticket.number}
            </span>{' '}
            {ticket.subject}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="truncate">{ticket.customer.name ?? ticket.customer.email}</span>
            {ticket.team && (
              <>
                <span aria-hidden="true">·</span>
                <span>{ticket.team.name}</span>
              </>
            )}
            <TagList tags={ticket.tags} />
          </div>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 md:contents">
          <span>
            <TicketStatusBadge status={ticket.status} />
          </span>
          <TicketPriorityLabel priority={ticket.priority} />
          <AssigneeLabel assignee={ticket.assignee} />
          <span className="text-xs whitespace-nowrap text-muted-foreground md:text-right">
            <span className="sr-only">Updated </span>
            <RelativeTime iso={ticket.updatedAt} />
          </span>
        </div>
      </div>
    </li>
  );
}

function ListSkeleton() {
  return (
    <div role="status" aria-label="Loading tickets" className="divide-y divide-border">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className={`px-4 py-3.5 sm:px-5 ${ROW_GRID}`}>
          <div className="grid gap-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="mt-2 h-5 w-16 md:mt-0" />
          <Skeleton className="hidden h-4 w-14 md:block" />
          <Skeleton className="hidden h-6 w-28 md:block" />
          <Skeleton className="hidden h-3 w-12 justify-self-end md:block" />
        </div>
      ))}
    </div>
  );
}

const COLUMN_HEADERS = ['Ticket', 'Status', 'Priority', 'Assignee', 'Updated'];

export function TicketInboxPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.toString();
  // Memoized on the query string so the filters (and the query key) only change with the URL.
  const filters = useMemo(() => filtersFromSearchParams(new URLSearchParams(search)), [search]);
  const tickets = useTicketList(filters);

  const setFilters = (next: TicketFilters) => setSearchParams(filtersToSearchParams(next));
  const rows = tickets.data?.pages.flatMap((p) => p.data) ?? [];
  const filtered = hasActiveFilters(filters);

  let body;
  if (tickets.isPending) {
    body = <ListSkeleton />;
  } else if (tickets.isError && rows.length === 0) {
    body = (
      <ErrorState
        title="Couldn’t load tickets"
        description={describeAuthError(tickets.error)}
        onRetry={() => void tickets.refetch()}
        retrying={tickets.isRefetching}
        className="m-4 border-0"
      />
    );
  } else if (rows.length === 0) {
    body = filtered ? (
      <EmptyState
        icon={SearchX}
        title="No tickets match these filters"
        description="Try a different status, assignee or tag, or clear the filters to see every ticket."
        className="m-4"
      >
        <Button variant="secondary" size="sm" onClick={() => setFilters({ sort: filters.sort })}>
          Show all tickets
        </Button>
      </EmptyState>
    ) : (
      <EmptyState
        icon={Inbox}
        title="No tickets yet"
        description="Tickets your customers send to this organization will appear here."
        className="m-4"
      />
    );
  } else {
    body = (
      <>
        <div
          aria-hidden="true"
          className={`hidden border-b border-border bg-surface-sunken/60 px-5 py-2 text-xs font-medium text-muted-foreground ${ROW_GRID}`}
        >
          {COLUMN_HEADERS.map((header) => (
            <span key={header} className={header === 'Updated' ? 'text-right' : undefined}>
              {header}
            </span>
          ))}
        </div>
        <ul
          aria-label="Tickets"
          aria-busy={tickets.isPlaceholderData || undefined}
          className={`divide-y divide-border transition-opacity ${tickets.isPlaceholderData ? 'opacity-60' : ''}`}
        >
          {rows.map((ticket) => (
            <TicketRow key={ticket.id} ticket={ticket} />
          ))}
        </ul>
        <div className="flex flex-col items-center gap-2 border-t border-border px-5 py-3 sm:flex-row sm:justify-between">
          <p className="text-xs text-muted-foreground" role="status">
            Showing {rows.length} {rows.length === 1 ? 'ticket' : 'tickets'}
          </p>
          {tickets.hasNextPage && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void tickets.fetchNextPage()}
              loading={tickets.isFetchingNextPage}
            >
              Load more tickets
            </Button>
          )}
          {tickets.isFetchNextPageError && (
            <p className="text-xs text-danger-foreground" role="alert">
              Couldn’t load more tickets. {describeAuthError(tickets.error)}
            </p>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Tickets"
        description="Every conversation with your customers, in one queue."
        actions={<NewTicketDialog />}
      />
      <Card className="mb-4 p-4">
        <TicketFiltersBar filters={filters} onChange={setFilters} />
      </Card>
      <Card className="overflow-hidden">{body}</Card>
    </>
  );
}
