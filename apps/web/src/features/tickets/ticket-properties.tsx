import {
  TICKET_PRIORITIES,
  allowedStatusTransitions,
  type SlaTargetState,
  type TicketSummary,
  type UpdateTicketRequest,
} from '@pulsedesk/shared';
import { Check, Tags } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NativeSelect } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { formatDateTime } from '@/lib/format-time';
import {
  useMemberOptions,
  useTagOptions,
  useTeamOptions,
  useUpdateTicket,
  type TicketUpdate,
} from './api';
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  SlaBadge,
  SlaTargetBadge,
  TicketPriorityLabel,
  TicketStatusBadge,
} from './ticket-badges';
import { describeTicketError } from './ticket-errors';
import { AssigneeLabel, TagList } from './ticket-parts';

const CHANNEL_LABELS: Record<TicketSummary['channel'], string> = {
  WEB: 'Web form',
  EMAIL: 'Email',
  API: 'API',
};

/** One row of the details list; the label names the control for assistive tech. */
function Property({
  label,
  children,
}: {
  label: string;
  children: (labelId: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 py-2 text-sm">
      <dt id={id} className="text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0">{children(id)}</dd>
    </div>
  );
}

function Timestamp({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-muted-foreground">—</span>;
  return <time dateTime={iso}>{formatDateTime(iso)}</time>;
}

/** A due date with that target's SLA state beside it. */
function DueDate({ iso, state }: { iso: string | null; state: SlaTargetState }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Timestamp iso={iso} />
      <SlaTargetBadge state={state} />
    </span>
  );
}

type Option = { value: string; label: string };

function PropertySelect({
  labelId,
  value,
  options,
  disabled,
  onChange,
}: {
  labelId: string;
  value: string;
  options: Option[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <NativeSelect
      aria-labelledby={labelId}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </NativeSelect>
  );
}

/** Keeps the current value selectable even if it is missing from the loaded options. */
function withCurrent(options: Option[], current: Option | null): Option[] {
  if (!current || options.some((o) => o.value === current.value)) return options;
  return [current, ...options];
}

function TagEditor({
  ticket,
  disabled,
  onChange,
}: {
  ticket: TicketSummary;
  disabled: boolean;
  onChange: (update: TicketUpdate) => void;
}) {
  const tags = useTagOptions();
  const selected = new Set(ticket.tags.map((t) => t.id));

  function toggle(tagId: string, checked: boolean) {
    const ids = checked
      ? [...ticket.tags.map((t) => t.id), tagId]
      : ticket.tags.map((t) => t.id).filter((id) => id !== tagId);
    const byId = new Map((tags.data ?? []).map((t) => [t.id, t]));
    onChange({
      request: { tagIds: ids },
      optimistic: {
        tags: ids.flatMap((id) => byId.get(id) ?? ticket.tags.filter((t) => t.id === id)),
      },
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {ticket.tags.length > 0 ? (
        <TagList tags={ticket.tags} max={ticket.tags.length} />
      ) : (
        <span className="text-muted-foreground">None</span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <Button variant="ghost" size="icon-sm" aria-label="Edit tags" className="size-7">
            <Tags aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Tags</DropdownMenuLabel>
          {tags.isPending && (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading tags…</p>
          )}
          {tags.isSuccess && tags.data.length === 0 && (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              No tags yet. Admins create tags in settings.
            </p>
          )}
          {tags.data?.map((tag) => (
            <DropdownMenuCheckboxItem
              key={tag.id}
              checked={selected.has(tag.id)}
              // Stay open, so several tags can be toggled in a row.
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => toggle(tag.id, checked)}
            >
              {tag.name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SaveState({ update }: { update: ReturnType<typeof useUpdateTicket> }) {
  if (update.isPending) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Spinner className="size-3" />
        Saving…
      </span>
    );
  }
  if (update.isSuccess) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-success-foreground">
        <Check className="size-3.5" aria-hidden="true" />
        Saved
      </span>
    );
  }
  return null;
}

/**
 * The ticket's properties. Open tickets edit in place: each control saves on change,
 * optimistically, and rolls back with an explanation if the server refuses. Closed
 * tickets are read-only.
 */
export function TicketProperties({ ticket }: { ticket: TicketSummary }) {
  const update = useUpdateTicket(ticket.number);
  const members = useMemberOptions();
  const teams = useTeamOptions();
  const editable = ticket.status !== 'CLOSED';
  // One change at a time: each request starts from the server's latest answer.
  const disabled = update.isPending;

  const save = (request: UpdateTicketRequest, optimistic: Partial<TicketSummary>) =>
    update.mutate({ request, optimistic });

  const statusOptions = [ticket.status, ...allowedStatusTransitions(ticket.status, 'agent')].map(
    (status) => ({ value: status, label: STATUS_LABELS[status] }),
  );
  const assigneeOptions = withCurrent(
    [
      { value: '', label: 'Unassigned' },
      ...(members.data ?? []).map((m) => ({ value: m.userId, label: m.name })),
    ],
    ticket.assignee && { value: ticket.assignee.userId, label: ticket.assignee.name },
  );
  const teamOptions = withCurrent(
    [
      { value: '', label: 'No team' },
      ...(teams.data ?? []).map((t) => ({ value: t.id, label: t.name })),
    ],
    ticket.team && { value: ticket.team.id, label: ticket.team.name },
  );

  return (
    <Card aria-labelledby="ticket-details-title">
      <CardHeader>
        <CardTitle id="ticket-details-title">Details</CardTitle>
        <span role="status">{editable && <SaveState update={update} />}</span>
      </CardHeader>
      <CardContent className="pt-2">
        {update.isError && (
          <p
            role="alert"
            className="mb-2 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2 text-sm text-danger-foreground"
          >
            {describeTicketError(update.error)}
          </p>
        )}
        <dl className="divide-y divide-border">
          <Property label="Status">
            {(labelId) =>
              editable ? (
                <PropertySelect
                  labelId={labelId}
                  value={ticket.status}
                  options={statusOptions}
                  disabled={disabled}
                  onChange={(value) => {
                    const status = statusOptions.find((o) => o.value === value)?.value;
                    if (status) save({ status }, { status });
                  }}
                />
              ) : (
                <TicketStatusBadge status={ticket.status} />
              )
            }
          </Property>
          <Property label="Priority">
            {(labelId) =>
              editable ? (
                <PropertySelect
                  labelId={labelId}
                  value={ticket.priority}
                  options={[...TICKET_PRIORITIES]
                    .reverse()
                    .map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))}
                  disabled={disabled}
                  onChange={(value) => {
                    const priority = TICKET_PRIORITIES.find((p) => p === value);
                    if (priority) save({ priority }, { priority });
                  }}
                />
              ) : (
                <TicketPriorityLabel priority={ticket.priority} />
              )
            }
          </Property>
          <Property label="Assignee">
            {(labelId) =>
              editable ? (
                <PropertySelect
                  labelId={labelId}
                  value={ticket.assignee?.userId ?? ''}
                  options={assigneeOptions}
                  disabled={disabled}
                  onChange={(value) => {
                    const option = assigneeOptions.find((o) => o.value === value);
                    save(
                      { assigneeUserId: value || null },
                      { assignee: value && option ? { userId: value, name: option.label } : null },
                    );
                  }}
                />
              ) : (
                <AssigneeLabel assignee={ticket.assignee} />
              )
            }
          </Property>
          <Property label="Team">
            {(labelId) =>
              editable ? (
                <PropertySelect
                  labelId={labelId}
                  value={ticket.team?.id ?? ''}
                  options={teamOptions}
                  disabled={disabled}
                  onChange={(value) => {
                    const option = teamOptions.find((o) => o.value === value);
                    save(
                      { teamId: value || null },
                      { team: value && option ? { id: value, name: option.label } : null },
                    );
                  }}
                />
              ) : (
                (ticket.team?.name ?? <span className="text-muted-foreground">No team</span>)
              )
            }
          </Property>
          <Property label="Tags">
            {() =>
              editable ? (
                <TagEditor
                  ticket={ticket}
                  disabled={disabled}
                  onChange={(change) => update.mutate(change)}
                />
              ) : ticket.tags.length > 0 ? (
                <TagList tags={ticket.tags} max={ticket.tags.length} />
              ) : (
                <span className="text-muted-foreground">None</span>
              )
            }
          </Property>
          <Property label="Customer">
            {() => (
              <>
                {ticket.customer.name && (
                  <span className="block truncate">{ticket.customer.name}</span>
                )}
                <span className="block truncate text-muted-foreground">
                  {ticket.customer.email}
                </span>
              </>
            )}
          </Property>
          <Property label="Channel">{() => CHANNEL_LABELS[ticket.channel]}</Property>
          <Property label="Created">{() => <Timestamp iso={ticket.createdAt} />}</Property>
          <Property label="SLA">
            {() =>
              ticket.sla.status === 'none' ? (
                <span className="text-muted-foreground">No SLA</span>
              ) : (
                <SlaBadge status={ticket.sla.status} />
              )
            }
          </Property>
          <Property label="First reply due">
            {() => <DueDate iso={ticket.firstResponseDueAt} state={ticket.sla.firstResponse} />}
          </Property>
          <Property label="First reply">
            {() => <Timestamp iso={ticket.firstRespondedAt} />}
          </Property>
          <Property label="Resolution due">
            {() => <DueDate iso={ticket.resolutionDueAt} state={ticket.sla.resolution} />}
          </Property>
          {ticket.solvedAt && (
            <Property label="Solved">{() => <Timestamp iso={ticket.solvedAt} />}</Property>
          )}
        </dl>
      </CardContent>
    </Card>
  );
}
