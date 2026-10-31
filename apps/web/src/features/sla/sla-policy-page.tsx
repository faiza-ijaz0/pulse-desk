import {
  DEFAULT_SLA_TARGETS,
  TICKET_PRIORITIES,
  hasPermission,
  type SlaPolicy,
  type TicketPriority,
  type UpdateSlaPolicyRequest,
} from '@pulsedesk/shared';
import { Check, Clock3, RotateCcw, Timer } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';
import { ErrorState, PageHeader } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Alert, Skeleton } from '@/components/ui/misc';
import { NativeSelect } from '@/components/ui/select';
import { describeAuthError } from '@/features/auth/form-helpers';
import { useActiveSession } from '@/features/auth/session';
import { describeDelay } from '@/features/settings/auto-close-delay';
import { PRIORITY_STRIPES, TicketPriorityLabel } from '@/features/tickets/ticket-badges';
import { ApiError, fieldErrorsByName } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format-time';
import { cn } from '@/lib/utils';
import { useSaveSlaPolicy, useSlaPolicy } from './api';
import {
  DURATION_UNITS,
  durationFromMinutes,
  minutesFromDuration,
  type DurationUnit,
} from './sla-duration';

// Most urgent first, as admins think about them.
const PRIORITIES = [...TICKET_PRIORITIES].reverse();
const FIELDS = ['firstResponseMinutes', 'resolutionMinutes'] as const;
type TargetField = (typeof FIELDS)[number];
const FIELD_LABELS: Record<TargetField, string> = {
  firstResponseMinutes: 'First response',
  resolutionMinutes: 'Resolution',
};
const UNIT_LABELS: Record<DurationUnit, string> = {
  minutes: 'Minutes',
  hours: 'Hours',
  days: 'Days',
};

type Duration = { amount: string; unit: DurationUnit };
type FormTargets = Record<TicketPriority, Record<TargetField, Duration>>;
/** Field errors keyed `PRIORITY.field`, e.g. `HIGH.resolutionMinutes`. */
type FormErrors = Partial<Record<string, string>>;

function toDuration(minutes: number): Duration {
  const { value, unit } = durationFromMinutes(minutes);
  return { amount: String(value), unit };
}

/** The form's starting values: the stored targets, or the defaults where there are none. */
function formTargets(policy: SlaPolicy | null): FormTargets {
  const result = {} as FormTargets;
  for (const priority of PRIORITIES) {
    const target = policy?.targets[priority] ?? DEFAULT_SLA_TARGETS[priority];
    result[priority] = {
      firstResponseMinutes: toDuration(target.firstResponseMinutes),
      resolutionMinutes: toDuration(target.resolutionMinutes),
    };
  }
  return result;
}

/** Validates every target; the request only when all of them are valid. */
function toRequest(
  targets: FormTargets,
): { ok: true; request: UpdateSlaPolicyRequest } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {};
  const request = { targets: {} } as UpdateSlaPolicyRequest;
  for (const priority of PRIORITIES) {
    const minutes: Partial<Record<TargetField, number>> = {};
    for (const field of FIELDS) {
      const parsed = minutesFromDuration(
        targets[priority][field].amount,
        targets[priority][field].unit,
      );
      if (parsed.ok) minutes[field] = parsed.minutes;
      else errors[`${priority}.${field}`] = parsed.error;
    }
    if (
      minutes.firstResponseMinutes !== undefined &&
      minutes.resolutionMinutes !== undefined &&
      minutes.resolutionMinutes < minutes.firstResponseMinutes
    ) {
      errors[`${priority}.resolutionMinutes`] = 'Must be at least the first-response target.';
    }
    const { firstResponseMinutes, resolutionMinutes } = minutes;
    if (firstResponseMinutes !== undefined && resolutionMinutes !== undefined) {
      request.targets[priority] = { firstResponseMinutes, resolutionMinutes };
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, request };
}

/** Server field errors (`body.targets.HIGH.resolutionMinutes`) keyed like the form's own. */
function serverErrors(error: unknown): FormErrors {
  if (!(error instanceof ApiError)) return {};
  const errors: FormErrors = {};
  for (const [path, message] of Object.entries(fieldErrorsByName(error))) {
    const match = /^targets\.([A-Z]+)\.(firstResponseMinutes|resolutionMinutes)$/.exec(path);
    if (match) errors[`${match[1]}.${match[2]}`] = message;
  }
  return errors;
}

function DurationField({
  label,
  value,
  error,
  disabled,
  onChange,
}: {
  label: string;
  value: Duration;
  error: string | undefined;
  disabled: boolean;
  onChange: (value: Duration) => void;
}) {
  return (
    <Field label={label} error={error} required>
      {(control) => (
        <div className="flex gap-2">
          <Input
            {...control}
            inputMode="numeric"
            autoComplete="off"
            className="w-20 tabular-nums"
            value={value.amount}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, amount: event.target.value })}
          />
          <NativeSelect
            aria-label={`${label} unit`}
            className="h-9 w-28"
            value={value.unit}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, unit: event.target.value as DurationUnit })}
          >
            {DURATION_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {UNIT_LABELS[unit]}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
    </Field>
  );
}

function PolicyForm({
  policy,
  save,
}: {
  policy: SlaPolicy | null;
  /** Owned by the page, so the "Saved" state survives the form's reset after a save. */
  save: ReturnType<typeof useSaveSlaPolicy>;
}) {
  const [targets, setTargets] = useState(() => formTargets(policy));
  const [errors, setErrors] = useState<FormErrors>({});
  const shownErrors = { ...(save.isError ? serverErrors(save.error) : {}), ...errors };
  const unexpected =
    save.isError && Object.keys(serverErrors(save.error)).length === 0
      ? describeAuthError(save.error)
      : undefined;

  function change(priority: TicketPriority, field: TargetField, value: Duration) {
    setTargets((current) => ({ ...current, [priority]: { ...current[priority], [field]: value } }));
    setErrors((current) => ({ ...current, [`${priority}.${field}`]: undefined }));
    save.reset();
  }

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = toRequest(targets);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    save.mutate(result.request);
  }

  return (
    <form aria-label="SLA targets" noValidate onSubmit={onSubmit} className="grid gap-5">
      {policy === null && (
        <Alert tone="warning" title="No SLA policy yet">
          Tickets get no due dates until you save. The targets below are the recommended defaults.
        </Alert>
      )}
      <div className="grid gap-3">
        {PRIORITIES.map((priority) => (
          <fieldset
            key={priority}
            className="relative grid gap-4 overflow-hidden rounded-xl border border-border bg-surface-sunken/40 py-4 pr-4 pl-5 sm:grid-cols-[7.5rem_1fr_1fr] sm:items-start"
          >
            <span
              aria-hidden="true"
              className={cn('absolute inset-y-0 left-0 w-1', PRIORITY_STRIPES[priority])}
            />
            <legend className="sr-only">
              <TicketPriorityLabel priority={priority} />
            </legend>
            <div aria-hidden="true" className="grid gap-1 sm:pt-7">
              <TicketPriorityLabel priority={priority} />
              {policy !== null && policy.targets[priority] === null && (
                <span className="text-xs text-warning-foreground">Not set yet</span>
              )}
            </div>
            {FIELDS.map((field) => (
              <DurationField
                key={field}
                label={FIELD_LABELS[field]}
                value={targets[priority][field]}
                error={shownErrors[`${priority}.${field}`]}
                disabled={save.isPending}
                onChange={(value) => change(priority, field, value)}
              />
            ))}
          </fieldset>
        ))}
      </div>

      {unexpected && (
        <Alert tone="danger" title="Couldn’t save the targets">
          {unexpected}
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" loading={save.isPending}>
          {policy === null ? 'Create policy' : 'Save targets'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={save.isPending}
          onClick={() => {
            setTargets(formTargets(null));
            setErrors({});
            save.reset();
          }}
        >
          <RotateCcw aria-hidden="true" />
          Use recommended targets
        </Button>
        <span role="status" className="text-xs text-success-foreground">
          {save.isSuccess && (
            <span className="inline-flex items-center gap-1">
              <Check className="size-3.5" aria-hidden="true" />
              Saved
            </span>
          )}
        </span>
      </div>
    </form>
  );
}

function ReadOnlyTargets({ policy }: { policy: SlaPolicy | null }) {
  if (policy === null) {
    return (
      <p className="text-sm text-muted-foreground">
        This organization has no SLA policy, so tickets have no due dates. An admin or owner can set
        targets here.
      </p>
    );
  }
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">SLA targets by priority</caption>
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th scope="col" className="py-2 pr-3 font-medium">
            Priority
          </th>
          <th scope="col" className="py-2 pr-3 font-medium">
            First response
          </th>
          <th scope="col" className="py-2 font-medium">
            Resolution
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {PRIORITIES.map((priority) => {
          const target = policy.targets[priority];
          return (
            <tr key={priority}>
              <th scope="row" className="py-2.5 pr-3 text-left font-normal">
                <TicketPriorityLabel priority={priority} />
              </th>
              <td className="py-2.5 pr-3 tabular-nums">
                {target ? describeDelay(target.firstResponseMinutes) : 'Not set'}
              </td>
              <td className="py-2.5 tabular-nums">
                {target ? describeDelay(target.resolutionMinutes) : 'Not set'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The rules the targets follow (docs/architecture/data-model.md, "SLA policies"). */
function HowTargetsApply() {
  const rules = [
    'Targets run in calendar time from when a ticket is created.',
    'A first response is the first public agent reply; resolution is when the ticket is solved.',
    'Changes apply to tickets created after you save. Existing tickets keep their due dates.',
    'Changing a ticket’s priority moves its open targets to the current ones for that priority, unless their due date has already passed.',
    'A recorded breach stays a breach, whatever changes later.',
  ];
  return (
    <Card aria-labelledby="sla-rules-title">
      <CardHeader>
        <div className="flex items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-subtle text-accent-subtle-foreground">
            <Clock3 className="size-4" aria-hidden="true" />
          </span>
          <div>
            <CardTitle id="sla-rules-title">How targets apply</CardTitle>
            <CardDescription>What a change does, and doesn’t, affect.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2.5 text-sm text-muted-foreground">
          {rules.map((rule) => (
            <li key={rule} className="flex gap-2.5">
              <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
              {rule}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function SlaPolicyPage() {
  const { activeOrganization } = useActiveSession();
  const canEdit = hasPermission(activeOrganization.role, 'sla:manage');
  const query = useSlaPolicy();
  const save = useSaveSlaPolicy();
  const policy = query.data?.policy ?? null;

  return (
    <>
      <PageHeader
        title="SLA policies"
        description="First-response and resolution targets for each ticket priority."
        meta={query.isSuccess && policy && <Badge tone="accent">{policy.name} · default</Badge>}
      />
      {!canEdit && (
        <Alert tone="info" title="View only" className="mb-4">
          Only admins and owners can change SLA targets.
        </Alert>
      )}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card aria-labelledby="sla-targets-title">
          <CardHeader>
            <div className="flex items-start gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-subtle text-accent-subtle-foreground">
                <Timer className="size-4" aria-hidden="true" />
              </span>
              <div>
                <CardTitle id="sla-targets-title">Targets</CardTitle>
                <CardDescription>
                  {policy
                    ? `Last changed ${formatDateTime(policy.updatedAt)}.`
                    : 'How quickly tickets should get a first reply and be solved.'}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {query.isPending ? (
              <div className="grid gap-3">
                <span role="status" className="sr-only">
                  Loading SLA targets…
                </span>
                {PRIORITIES.map((priority) => (
                  <Skeleton key={priority} className="h-20" />
                ))}
              </div>
            ) : query.isError ? (
              <ErrorState
                title="Couldn’t load SLA targets"
                description={describeAuthError(query.error)}
                onRetry={() => void query.refetch()}
                retrying={query.isRefetching}
                className="border-0 py-6"
              />
            ) : canEdit ? (
              <PolicyForm
                // Reset the form when the saved policy changes (e.g. after a save).
                key={policy?.updatedAt ?? 'none'}
                policy={policy}
                save={save}
              />
            ) : (
              <ReadOnlyTargets policy={policy} />
            )}
          </CardContent>
        </Card>
        <HowTargetsApply />
      </div>
    </>
  );
}
