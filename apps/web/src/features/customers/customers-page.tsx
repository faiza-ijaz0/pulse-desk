import { SEARCH_QUERY_MAX_LENGTH, type Customer } from '@pulsedesk/shared';
import { Search, SearchX, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { EmptyState, ErrorState, PageHeader } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Avatar, Skeleton } from '@/components/ui/misc';
import { describeAuthError } from '@/features/auth/form-helpers';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useCustomerList } from './api';

const SEARCH_DELAY_MS = 300;

export function displayName(customer: Pick<Customer, 'name' | 'email'>): string {
  return customer.name ?? customer.email;
}

function ticketSummary(customer: Customer): string {
  if (customer.ticketCount === 0) return 'No tickets';
  const total = `${customer.ticketCount} ${customer.ticketCount === 1 ? 'ticket' : 'tickets'}`;
  return customer.activeTicketCount > 0 ? `${total} · ${customer.activeTicketCount} active` : total;
}

function CustomerRow({ customer }: { customer: Customer }) {
  return (
    // The name link stretches over the row, like ticket rows in the inbox.
    <li className="relative flex items-center gap-3 px-4 py-3.5 transition-colors focus-within:bg-accent-subtle/45 hover:bg-accent-subtle/45 sm:px-5">
      <Avatar name={displayName(customer)} className="ring-0" />
      <div className="min-w-0 flex-1">
        <Link
          to={`/customers/${customer.id}`}
          className="block truncate text-sm font-medium after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
        >
          {displayName(customer)}
        </Link>
        {customer.name && (
          <p className="truncate text-xs text-muted-foreground">{customer.email}</p>
        )}
      </div>
      <p className="shrink-0 text-xs text-muted-foreground">{ticketSummary(customer)}</p>
    </li>
  );
}

function ListSkeleton() {
  return (
    <div role="status" aria-label="Loading customers" className="divide-y divide-border">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-5 py-3.5">
          <Skeleton className="size-8 rounded-full" />
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function CustomersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get('q') ?? '';
  const [text, setText] = useState(urlQuery);
  const debounced = useDebouncedValue(text.trim(), SEARCH_DELAY_MS);

  // The URL follows the debounced text, so links and reloads keep the search.
  useEffect(() => {
    if (debounced === urlQuery) return;
    setSearchParams(debounced ? { q: debounced } : {}, { replace: true });
  }, [debounced, urlQuery, setSearchParams]);

  const customers = useCustomerList(urlQuery);
  const rows = customers.data?.pages.flatMap((page) => page.data) ?? [];

  let body;
  if (customers.isPending) {
    body = <ListSkeleton />;
  } else if (customers.isError && rows.length === 0) {
    body = (
      <ErrorState
        title="Couldn’t load customers"
        description={describeAuthError(customers.error)}
        onRetry={() => void customers.refetch()}
        retrying={customers.isRefetching}
        className="m-4 border-0"
      />
    );
  } else if (rows.length === 0) {
    body = urlQuery ? (
      <EmptyState
        icon={SearchX}
        title={`No customers match “${urlQuery}”`}
        description="Search matches part of a customer’s name or email address."
        className="m-4"
      />
    ) : (
      <EmptyState
        icon={Users}
        title="No customers yet"
        description="Customers appear here when they open their first ticket."
        className="m-4"
      />
    );
  } else {
    body = (
      <>
        <ul
          aria-label="Customers"
          aria-busy={customers.isPlaceholderData || undefined}
          className={`divide-y divide-border transition-opacity ${customers.isPlaceholderData ? 'opacity-60' : ''}`}
        >
          {rows.map((customer) => (
            <CustomerRow key={customer.id} customer={customer} />
          ))}
        </ul>
        <div className="flex flex-col items-center gap-2 border-t border-border px-5 py-3 sm:flex-row sm:justify-between">
          <p className="text-xs text-muted-foreground" role="status">
            Showing {rows.length} {rows.length === 1 ? 'customer' : 'customers'}, by email
          </p>
          {customers.hasNextPage && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void customers.fetchNextPage()}
              loading={customers.isFetchingNextPage}
            >
              Load more customers
            </Button>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Customers" description="Everyone who has contacted your organization." />
      <Card className="mb-4 bg-surface/85 p-4 backdrop-blur-md">
        <div className="relative max-w-md">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label="Search customers"
            placeholder="Search by name or email…"
            maxLength={SEARCH_QUERY_MAX_LENGTH}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="pl-9"
          />
        </div>
      </Card>
      <Card className="overflow-hidden">{body}</Card>
    </>
  );
}
