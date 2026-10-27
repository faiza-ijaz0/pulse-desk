import {
  customerParamsSchema,
  hasPermission,
  updateCustomerRequestSchema,
  type Customer,
} from '@pulsedesk/shared';
import { ArrowLeft, Inbox, Pencil, UserRoundSearch } from 'lucide-react';
import { useRef, useState, type SubmitEvent } from 'react';
import { Link, useParams } from 'react-router';
import { EmptyState, ErrorState } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Alert, Avatar, Skeleton } from '@/components/ui/misc';
import { describeAuthError, focusFirstInvalid, issuesByField } from '@/features/auth/form-helpers';
import { useActiveSession } from '@/features/auth/session';
import { useTicketList } from '@/features/tickets/api';
import { TicketRow } from '@/features/tickets/ticket-inbox-page';
import { ApiError, fieldErrorsByName } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format-time';
import { useCustomer, useUpdateCustomer } from './api';
import { displayName } from './customers-page';

function BackLink() {
  return (
    <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2.5">
      <Link to="/customers">
        <ArrowLeft aria-hidden="true" />
        All customers
      </Link>
    </Button>
  );
}

function ContactForm({ customer, onDone }: { customer: Customer; onDone: () => void }) {
  const update = useUpdateCustomer(customer.id);
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState({ name: customer.name ?? '', email: customer.email });
  const [errors, setErrors] = useState<Record<string, string>>({});

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = updateCustomerRequestSchema.safeParse({
      name: values.name.trim() === '' ? null : values.name,
      email: values.email,
    });
    if (!result.success) {
      setErrors(issuesByField(result.error));
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    setErrors({});
    update.mutate(result.data, {
      onSuccess: onDone,
      onError: (error) => {
        if (error instanceof ApiError && error.code === 'CONFLICT') {
          setErrors({ email: error.message });
        } else if (error instanceof ApiError && error.fieldErrors.length > 0) {
          setErrors(fieldErrorsByName(error));
        } else {
          return;
        }
        requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      },
    });
  }

  const unexpected =
    update.isError &&
    !(
      update.error instanceof ApiError &&
      (update.error.code === 'CONFLICT' || update.error.fieldErrors.length > 0)
    );

  return (
    <form
      ref={formRef}
      aria-label="Edit contact details"
      noValidate
      onSubmit={onSubmit}
      className="grid gap-4"
      aria-busy={update.isPending}
    >
      {unexpected && (
        <Alert tone="danger" title="Couldn’t save the contact details">
          {describeAuthError(update.error)}
        </Alert>
      )}
      <Field label="Name" description="Leave empty if you don’t know it." error={errors.name}>
        {(control) => (
          <Input
            {...control}
            value={values.name}
            onChange={(e) => setValues({ ...values, name: e.target.value })}
            disabled={update.isPending}
          />
        )}
      </Field>
      <Field label="Email" error={errors.email} required>
        {(control) => (
          <Input
            {...control}
            type="email"
            autoCapitalize="none"
            spellCheck={false}
            value={values.email}
            onChange={(e) => setValues({ ...values, email: e.target.value })}
            disabled={update.isPending}
          />
        )}
      </Field>
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={update.isPending}>
          Save
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDone}
          disabled={update.isPending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ContactCard({ customer }: { customer: Customer }) {
  const { activeOrganization } = useActiveSession();
  const canEdit = hasPermission(activeOrganization.role, 'customer:update');
  const [editing, setEditing] = useState(false);

  return (
    <Card aria-labelledby="contact-title">
      <CardHeader>
        <CardTitle id="contact-title">Contact</CardTitle>
        {canEdit && !editing && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Edit contact details"
            onClick={() => setEditing(true)}
          >
            <Pencil aria-hidden="true" />
          </Button>
        )}
      </CardHeader>
      <CardContent className="pt-2">
        {editing ? (
          <ContactForm customer={customer} onDone={() => setEditing(false)} />
        ) : (
          <dl className="grid gap-3 text-sm">
            <div>
              <dt className="text-muted-foreground">Name</dt>
              <dd>{customer.name ?? <span className="text-muted-foreground">Not known</span>}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Email</dt>
              <dd className="break-all">{customer.email}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Customer since</dt>
              <dd>
                <time dateTime={customer.createdAt}>{formatDateTime(customer.createdAt)}</time>
              </dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function TicketHistory({ customer }: { customer: Customer }) {
  const tickets = useTicketList({ sort: 'newest', customer: customer.id });
  const rows = tickets.data?.pages.flatMap((page) => page.data) ?? [];

  let body;
  if (tickets.isPending) {
    body = (
      <div role="status" aria-label="Loading tickets" className="grid gap-3 p-5">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
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
    body = (
      <EmptyState
        icon={Inbox}
        title="No tickets yet"
        description="Tickets from this customer will appear here."
        className="m-4"
      />
    );
  } else {
    body = (
      <>
        <ul aria-label="Ticket history" className="divide-y divide-border">
          {rows.map((ticket) => (
            <TicketRow key={ticket.id} ticket={ticket} />
          ))}
        </ul>
        {tickets.hasNextPage && (
          <div className="flex justify-center border-t border-border px-5 py-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void tickets.fetchNextPage()}
              loading={tickets.isFetchingNextPage}
            >
              Load more tickets
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <Card aria-labelledby="history-title" className="min-w-0 overflow-hidden">
      <CardHeader className="pb-3">
        <CardTitle id="history-title">Tickets</CardTitle>
        <Button asChild variant="ghost" size="sm">
          <Link to={`/tickets?customer=${customer.id}`}>Open in inbox</Link>
        </Button>
      </CardHeader>
      <div className="border-t border-border">{body}</div>
    </Card>
  );
}

function NotFound() {
  return (
    <EmptyState
      icon={UserRoundSearch}
      title="Customer not found"
      description="There’s no such customer in your current organization."
    >
      <Button asChild variant="secondary" size="sm">
        <Link to="/customers">
          <ArrowLeft aria-hidden="true" />
          All customers
        </Link>
      </Button>
    </EmptyState>
  );
}

export function CustomerDetailPage() {
  const params = customerParamsSchema.safeParse(useParams());
  const id = params.success ? params.data.customerId : undefined;
  const customer = useCustomer(id);

  if (id === undefined) return <NotFound />;
  if (customer.isPending) {
    return (
      <div role="status" aria-label="Loading customer">
        <Skeleton className="mb-6 h-10 w-1/3" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (customer.isError) {
    if (customer.error instanceof ApiError && customer.error.status === 404) return <NotFound />;
    return (
      <>
        <BackLink />
        <ErrorState
          title="Couldn’t load this customer"
          description={describeAuthError(customer.error)}
          onRetry={() => void customer.refetch()}
          retrying={customer.isRefetching}
        />
      </>
    );
  }

  const data = customer.data;
  return (
    <>
      <BackLink />
      <div className="mb-6 flex min-w-0 items-center gap-3">
        <Avatar name={displayName(data)} className="size-10 ring-0" />
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{displayName(data)}</h1>
          <p className="text-sm text-muted-foreground">
            {data.ticketCount} {data.ticketCount === 1 ? 'ticket' : 'tickets'} ·{' '}
            {data.activeTicketCount} active
          </p>
        </div>
      </div>
      {/* Contact first on small screens; beside the history on large ones. */}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="lg:col-start-2 lg:row-start-1">
          <ContactCard customer={data} />
        </div>
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <TicketHistory customer={data} />
        </div>
      </div>
    </>
  );
}
