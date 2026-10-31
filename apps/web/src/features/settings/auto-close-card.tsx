import type { Organization, UpdateOrganizationRequest } from '@pulsedesk/shared';
import { Check, TimerReset } from 'lucide-react';
import { useId, useState, type SubmitEvent } from 'react';
import { ErrorState } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Alert, Skeleton } from '@/components/ui/misc';
import { NativeSelect } from '@/components/ui/select';
import { describeAuthError } from '@/features/auth/form-helpers';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useOrganization, useUpdateOrganization } from './api';
import {
  delayFromMinutes,
  describeDelay,
  minutesFromDelay,
  type DelayUnit,
} from './auto-close-delay';

const RULE =
  'The delay counts from when a ticket was solved or last updated, whichever is later, so any recent work keeps it open. Closed tickets are read-only.';

/** A labelled on/off control: a native checkbox exposed as a switch, with its state in words. */
function Switch({
  checked,
  onChange,
  disabled,
  label,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
  label: string;
  description: string;
}) {
  const descriptionId = useId();
  return (
    <label
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer',
      )}
    >
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-describedby={descriptionId}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={cn(
          'relative mt-0.5 inline-flex h-5 w-9 shrink-0 rounded-full transition-colors duration-150',
          'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring',
          'after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-surface after:shadow-sm after:transition-transform after:duration-150',
          checked ? 'bg-accent after:translate-x-4' : 'bg-subtle-foreground',
          disabled && 'opacity-60',
        )}
      />
      <span className="flex items-center gap-2 text-sm font-medium">
        {label}
        {/* The state in words for sighted users; assistive tech reads the switch's own state. */}
        <span
          aria-hidden="true"
          className={cn(
            'rounded-full px-1.5 text-2xs font-semibold',
            checked
              ? 'bg-accent-subtle text-accent-subtle-foreground'
              : 'bg-surface-sunken text-muted-foreground',
          )}
        >
          {checked ? 'On' : 'Off'}
        </span>
      </span>
      <span id={descriptionId} className="col-start-2 mt-0.5 text-sm text-muted-foreground">
        {description}
      </span>
    </label>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.fieldErrors[0]) return error.fieldErrors[0].message;
  return describeAuthError(error);
}

function AutoCloseForm({
  organization,
  update,
}: {
  organization: Organization;
  /** Owned by the card, so the "Saved" state survives the form's reset after a save. */
  update: ReturnType<typeof useUpdateOrganization>;
}) {
  const stored = delayFromMinutes(organization.autoCloseAfterMinutes);
  const [enabled, setEnabled] = useState(organization.autoCloseEnabled);
  const [amount, setAmount] = useState(stored ? String(stored.value) : '');
  const [unit, setUnit] = useState<DelayUnit>(stored?.unit ?? 'hours');
  const [delayTouched, setDelayTouched] = useState(false);
  const [error, setError] = useState<string>();

  const changed = () => {
    setError(undefined);
    update.reset();
  };

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const request: UpdateOrganizationRequest = {};
    if (enabled !== organization.autoCloseEnabled) request.autoCloseEnabled = enabled;
    // A delay set elsewhere that isn't whole hours is kept until the admin enters a new one.
    if (stored !== null || delayTouched) {
      const delay = minutesFromDelay(amount, unit);
      if (!delay.ok) {
        setError(delay.error);
        return;
      }
      if (delay.minutes !== organization.autoCloseAfterMinutes) {
        request.autoCloseAfterMinutes = delay.minutes;
      }
    }
    setError(undefined);
    if (Object.keys(request).length === 0) return; // nothing changed; nothing to save
    update.mutate(request);
  }

  const turningOn = enabled && !organization.autoCloseEnabled;

  return (
    <form aria-label="Auto-close settings" noValidate onSubmit={onSubmit} className="grid gap-5">
      <Switch
        checked={enabled}
        disabled={update.isPending}
        onChange={(next) => {
          setEnabled(next);
          changed();
        }}
        label="Close solved tickets automatically"
        description="Solved tickets with no further activity close after the delay below."
      />

      <Field
        label="Close after"
        description={
          stored === null && !delayTouched
            ? `Currently ${describeDelay(organization.autoCloseAfterMinutes)}. Enter hours or days to change it.`
            : '1 hour to 365 days. The delay is kept while auto-close is off.'
        }
        error={error ?? (update.isError ? errorMessage(update.error) : undefined)}
        required
      >
        {(control) => (
          <div className="flex gap-2">
            <Input
              {...control}
              inputMode="numeric"
              autoComplete="off"
              className="w-28"
              value={amount}
              disabled={update.isPending}
              onChange={(event) => {
                setAmount(event.target.value);
                setDelayTouched(true);
                changed();
              }}
            />
            <NativeSelect
              aria-label="Unit"
              className="h-9 w-28"
              value={unit}
              disabled={update.isPending}
              onChange={(event) => {
                setUnit(event.target.value as DelayUnit);
                setDelayTouched(true);
                changed();
              }}
            >
              <option value="hours">Hours</option>
              <option value="days">Days</option>
            </NativeSelect>
          </div>
        )}
      </Field>

      <p className="text-sm text-muted-foreground">{RULE}</p>

      {turningOn && (
        <Alert tone="warning" title="Already-solved tickets are included">
          When you save, solved tickets that have had no activity for longer than the delay close at
          the next automatic check, within a few minutes.
        </Alert>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" loading={update.isPending}>
          Save auto-close
        </Button>
        <span role="status" className="text-xs text-success-foreground">
          {update.isSuccess && (
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

/** Organization-wide automatic closure of solved tickets. Admins and owners can change it. */
export function AutoCloseCard({ canEdit }: { canEdit: boolean }) {
  const organization = useOrganization();
  const update = useUpdateOrganization();
  return (
    <Card aria-labelledby="auto-close-title">
      <CardHeader>
        <div className="flex items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-subtle text-accent-subtle-foreground">
            <TimerReset className="size-4" aria-hidden="true" />
          </span>
          <div>
            <CardTitle id="auto-close-title">Auto-close</CardTitle>
            <CardDescription>
              Close solved tickets automatically after a quiet period.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {organization.isPending ? (
          <Skeleton className="h-36" />
        ) : organization.isError ? (
          <ErrorState
            title="Couldn’t load auto-close settings"
            description={describeAuthError(organization.error)}
            onRetry={() => void organization.refetch()}
            retrying={organization.isRefetching}
            className="border-0 py-6"
          />
        ) : canEdit ? (
          <AutoCloseForm
            // Reset the form when the saved settings change (e.g. after a save elsewhere).
            key={`${organization.data.autoCloseEnabled}-${organization.data.autoCloseAfterMinutes}`}
            organization={organization.data}
            update={update}
          />
        ) : (
          <div className="grid gap-3">
            <dl className="grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
              <dt className="text-muted-foreground">Auto-close</dt>
              <dd>{organization.data.autoCloseEnabled ? 'On' : 'Off'}</dd>
              <dt className="text-muted-foreground">Close after</dt>
              <dd>{describeDelay(organization.data.autoCloseAfterMinutes)}</dd>
            </dl>
            <p className="text-sm text-muted-foreground">{RULE}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
