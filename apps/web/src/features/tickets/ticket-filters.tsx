import {
  ACTIVE_TICKET_STATUSES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketSort,
} from '@pulsedesk/shared';
import { X } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/select';
import { useMemberOptions, useTagOptions, useTeamOptions } from './api';
import { hasActiveFilters, type TicketFilters } from './filters';
import { PRIORITY_LABELS, STATUS_LABELS } from './ticket-badges';

type Option = { value: string; label: string };

/** A filter control: a visibly labelled native select. */
function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="grid min-w-0 gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <NativeSelect id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

const ACTIVE = 'active';
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

/**
 * Single-choice controls over list-valued filters. A combination that only a URL can
 * express (e.g. `status=OPEN,SOLVED`) still shows up, as its own "custom" option.
 */
function listSelect<T extends string>(
  selected: T[] | undefined,
  labels: Record<T, string>,
  all: readonly T[],
  presets: { value: string; label: string; values: readonly T[] }[] = [],
) {
  const options: Option[] = [
    ...presets.map(({ value, label }) => ({ value, label })),
    ...all.map((value) => ({ value, label: labels[value] })),
  ];
  if (!selected?.length) return { value: '', options };
  const preset = presets.find((p) => sameSet(p.values, selected));
  if (preset) return { value: preset.value, options };
  if (selected.length === 1) return { value: selected[0] ?? '', options };
  const custom = selected.join(',');
  return {
    value: custom,
    options: [...options, { value: custom, label: selected.map((v) => labels[v]).join(', ') }],
  };
}

function withAny(label: string, options: Option[]): Option[] {
  return [{ value: '', label }, ...options];
}

/** Keeps a URL value selectable while options load, or after the item was deleted. */
function withCurrent(options: Option[], value: string | undefined, fallback: string): Option[] {
  if (!value || options.some((o) => o.value === value)) return options;
  return [...options, { value, label: fallback }];
}

const SORT_OPTIONS: { value: TicketSort; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'updated', label: 'Recently updated' },
];

export function TicketFiltersBar({
  filters,
  onChange,
  actions,
}: {
  filters: TicketFilters;
  onChange: (filters: TicketFilters) => void;
  actions?: ReactNode;
}) {
  const members = useMemberOptions();
  const teams = useTeamOptions();
  const tags = useTagOptions();

  const status = listSelect(filters.status, STATUS_LABELS, TICKET_STATUSES, [
    { value: ACTIVE, label: 'Active (open, pending, on hold)', values: ACTIVE_TICKET_STATUSES },
  ]);
  const priority = listSelect(filters.priority, PRIORITY_LABELS, [...TICKET_PRIORITIES].reverse());

  /** Applies a change; a filter set to undefined is removed. */
  const set = (patch: { [Key in keyof TicketFilters]?: TicketFilters[Key] | undefined }) => {
    const merged = { ...filters, ...patch };
    const next: TicketFilters = { sort: merged.sort ?? filters.sort };
    if (merged.status) next.status = merged.status;
    if (merged.priority) next.priority = merged.priority;
    if (merged.assignee) next.assignee = merged.assignee;
    if (merged.team) next.team = merged.team;
    if (merged.tag) next.tag = merged.tag;
    // Set from a customer's page; there is no control for it here, so it is carried along.
    if (filters.customer) next.customer = filters.customer;
    onChange(next);
  };

  const statusValues = (value: string) =>
    value === ACTIVE
      ? [...ACTIVE_TICKET_STATUSES]
      : TICKET_STATUSES.filter((s) => value.split(',').includes(s));
  const priorityValues = (value: string) =>
    TICKET_PRIORITIES.filter((p) => value.split(',').includes(p));

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
      <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <FilterSelect
          label="Status"
          value={status.value}
          options={withAny('Any status', status.options)}
          onChange={(value) => set({ status: value ? statusValues(value) : undefined })}
        />
        <FilterSelect
          label="Priority"
          value={priority.value}
          options={withAny('Any priority', priority.options)}
          onChange={(value) => set({ priority: value ? priorityValues(value) : undefined })}
        />
        <FilterSelect
          label="Assignee"
          value={filters.assignee ?? ''}
          options={withCurrent(
            withAny('Anyone', [
              { value: 'me', label: 'Assigned to me' },
              { value: 'unassigned', label: 'Unassigned' },
              ...(members.data ?? []).map((m) => ({ value: m.userId, label: m.name })),
            ]),
            filters.assignee,
            members.isPending ? 'Loading…' : 'Former member',
          )}
          onChange={(value) => set({ assignee: value || undefined })}
        />
        <FilterSelect
          label="Team"
          value={filters.team ?? ''}
          options={withCurrent(
            withAny('Any team', [
              { value: 'none', label: 'No team' },
              ...(teams.data ?? []).map((t) => ({ value: t.id, label: t.name })),
            ]),
            filters.team,
            teams.isPending ? 'Loading…' : 'Deleted team',
          )}
          onChange={(value) => set({ team: value || undefined })}
        />
        <FilterSelect
          label="Tag"
          value={filters.tag ?? ''}
          options={withCurrent(
            withAny(
              'Any tag',
              (tags.data ?? []).map((t) => ({ value: t.id, label: t.name })),
            ),
            filters.tag,
            tags.isPending ? 'Loading…' : 'Deleted tag',
          )}
          onChange={(value) => set({ tag: value || undefined })}
        />
        <FilterSelect
          label="Sort"
          value={filters.sort}
          options={SORT_OPTIONS}
          onChange={(value) => {
            const sort = SORT_OPTIONS.find((o) => o.value === value)?.value;
            if (sort) set({ sort });
          }}
        />
      </div>
      <div className="flex items-center gap-2">
        {filters.customer && (
          <span className="inline-flex h-8 items-center rounded-md border border-border bg-surface-sunken px-2.5 text-xs text-muted-foreground">
            One customer’s tickets
          </span>
        )}
        {hasActiveFilters(filters) && (
          <Button variant="ghost" size="sm" onClick={() => onChange({ sort: filters.sort })}>
            <X aria-hidden="true" />
            Clear filters
          </Button>
        )}
        {actions}
      </div>
    </div>
  );
}
