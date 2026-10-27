import { createTeamRequestSchema, hasPermission, type Team } from '@pulsedesk/shared';
import { Pencil, Trash2, UsersRound, X } from 'lucide-react';
import { useId, useState, type SubmitEvent } from 'react';
import { EmptyState, ErrorState, PageHeader } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Alert, Avatar, Skeleton } from '@/components/ui/misc';
import { NativeSelect } from '@/components/ui/select';
import { ROLE_LABELS } from '@/features/auth/role-label';
import { useActiveSession } from '@/features/auth/session';
import { describeAuthError } from '@/features/auth/form-helpers';
import { useMemberOptions, useTeamOptions } from '@/features/tickets/api';
import { ApiError } from '@/lib/api-client';
import {
  useAddTeamMember,
  useCreateTeam,
  useDeleteTeam,
  useRemoveTeamMember,
  useRenameTeam,
} from './api';

/** A field-level message for a failed team name change: validation and conflicts included. */
function nameError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'CONFLICT') return error.message;
    if (error.fieldErrors[0]) return error.fieldErrors[0].message;
  }
  return describeAuthError(error);
}

function TeamNameForm({
  label,
  initial = '',
  submitLabel,
  pending,
  serverError,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial?: string;
  submitLabel: string;
  pending: boolean;
  serverError: string | undefined;
  onSubmit: (name: string, reset: () => void) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string>();

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = createTeamRequestSchema.safeParse({ name });
    if (!result.success) {
      setError(result.error.issues[0]?.message);
      return;
    }
    setError(undefined);
    onSubmit(result.data.name, () => setName(''));
  }

  return (
    <form aria-label={label} noValidate onSubmit={submit} className="grid gap-3">
      <Field label="Team name" error={error ?? serverError}>
        {(control) => (
          <Input
            {...control}
            maxLength={60}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(undefined);
            }}
            disabled={pending}
          />
        )}
      </Field>
      <div className="flex gap-2 sm:justify-end">
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        )}
        <Button type="submit" loading={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function NewTeamCard() {
  const create = useCreateTeam();
  return (
    <Card aria-labelledby="new-team-title">
      <CardHeader>
        <CardTitle id="new-team-title">New team</CardTitle>
      </CardHeader>
      <CardContent>
        <TeamNameForm
          label="New team"
          submitLabel="Create team"
          pending={create.isPending}
          serverError={create.isError ? nameError(create.error) : undefined}
          onSubmit={(name, reset) => create.mutate(name, { onSuccess: reset })}
        />
      </CardContent>
    </Card>
  );
}

function TeamCard({ team, canManage }: { team: Team; canManage: boolean }) {
  const titleId = useId();
  const members = useMemberOptions();
  const add = useAddTeamMember();
  const remove = useRemoveTeamMember();
  const rename = useRenameTeam();
  const del = useDeleteTeam();
  const [candidate, setCandidate] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const onTeam = new Set(team.members.map((m) => m.userId));
  const candidates = (members.data ?? []).filter((m) => !onTeam.has(m.userId));
  const memberError = add.error ?? remove.error;

  return (
    <Card aria-labelledby={titleId}>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle id={titleId} className="truncate">
            {team.name}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {team.members.length === 0
              ? 'No members'
              : `${team.members.length} ${team.members.length === 1 ? 'member' : 'members'}`}
          </p>
        </div>
        {canManage && (
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Rename ${team.name}`}
              onClick={() => {
                rename.reset();
                setRenaming(true);
              }}
            >
              <Pencil aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete ${team.name}`}
              onClick={() => {
                del.reset();
                setConfirming(true);
              }}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="grid gap-3 pt-3">
        {team.members.length > 0 && (
          <ul aria-label={`Members of ${team.name}`} className="grid gap-1.5">
            {team.members.map((member) => (
              <li key={member.userId} className="flex items-center gap-2 text-sm">
                <Avatar name={member.name} size="sm" className="ring-0" />
                <span className="min-w-0 flex-1 truncate">{member.name}</span>
                {canManage && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-7"
                    aria-label={`Remove ${member.name} from ${team.name}`}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate({ teamId: team.id, userId: member.userId })}
                  >
                    <X aria-hidden="true" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!candidate) return;
              add.mutate(
                { teamId: team.id, userId: candidate },
                { onSuccess: () => setCandidate('') },
              );
            }}
          >
            <div className="min-w-0 flex-1">
              <NativeSelect
                aria-label={`Add a member to ${team.name}`}
                value={candidate}
                onChange={(e) => setCandidate(e.target.value)}
                disabled={add.isPending || candidates.length === 0}
              >
                <option value="">
                  {members.isPending
                    ? 'Loading members…'
                    : candidates.length === 0
                      ? 'Everyone is on this team'
                      : 'Choose someone…'}
                </option>
                {candidates.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              loading={add.isPending}
              disabled={!candidate}
            >
              Add
            </Button>
          </form>
        )}
        {memberError && (
          <p role="alert" className="text-xs text-danger-foreground">
            {describeAuthError(memberError)}
          </p>
        )}
      </CardContent>

      <Dialog open={renaming} onOpenChange={(open) => !rename.isPending && setRenaming(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename team</DialogTitle>
          </DialogHeader>
          <TeamNameForm
            label="Rename team"
            initial={team.name}
            submitLabel="Save"
            pending={rename.isPending}
            serverError={rename.isError ? nameError(rename.error) : undefined}
            onCancel={() => setRenaming(false)}
            onSubmit={(name) =>
              rename.mutate({ teamId: team.id, name }, { onSuccess: () => setRenaming(false) })
            }
          />
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${team.name}?`}
        description="Tickets in this team keep their history but are no longer assigned to any team. Members stay in the organization."
        confirmLabel="Delete team"
        pending={del.isPending}
        error={del.isError ? describeAuthError(del.error) : undefined}
        onConfirm={() => del.mutate(team.id, { onSuccess: () => setConfirming(false) })}
      />
    </Card>
  );
}

function MembersCard() {
  const members = useMemberOptions();
  return (
    <Card aria-labelledby="members-title">
      <CardHeader>
        <CardTitle id="members-title">Members</CardTitle>
      </CardHeader>
      <CardContent className="pt-3">
        {members.isPending ? (
          <Skeleton className="h-24" />
        ) : members.isError ? (
          <p role="alert" className="text-sm text-danger-foreground">
            {describeAuthError(members.error)}
          </p>
        ) : (
          <ul aria-label="Organization members" className="grid gap-2.5">
            {members.data.map((member) => (
              <li key={member.userId} className="flex items-center gap-2.5 text-sm">
                <Avatar name={member.name} size="sm" className="ring-0" />
                <div className="min-w-0 flex-1">
                  <p className="truncate">{member.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                </div>
                <Badge tone={member.role === 'AGENT' ? 'neutral' : 'accent'}>
                  {ROLE_LABELS[member.role]}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function TeamPage() {
  const { activeOrganization } = useActiveSession();
  const canManage = hasPermission(activeOrganization.role, 'team:manage');
  const teams = useTeamOptions();

  let body;
  if (teams.isPending) {
    body = (
      <div role="status" aria-label="Loading teams" className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    );
  } else if (teams.isError) {
    body = (
      <ErrorState
        title="Couldn’t load teams"
        description={describeAuthError(teams.error)}
        onRetry={() => void teams.refetch()}
        retrying={teams.isRefetching}
      />
    );
  } else if (teams.data.length === 0) {
    body = (
      <EmptyState
        icon={UsersRound}
        title="No teams yet"
        description={
          canManage
            ? 'Create a team to group agents, then assign tickets to it.'
            : 'An admin can create teams to group agents.'
        }
      />
    );
  } else {
    body = (
      <div className="grid gap-4 sm:grid-cols-2">
        {teams.data.map((team) => (
          <TeamCard key={team.id} team={team} canManage={canManage} />
        ))}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Agents & teams"
        description="Who works in this organization, and how they’re grouped."
      />
      {!canManage && (
        <Alert tone="info" title="View only" className="mb-4">
          Only admins and owners can manage teams.
        </Alert>
      )}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-labelledby="teams-title" className="grid min-w-0 gap-4">
          <h2 id="teams-title" className="text-base font-semibold">
            Teams
          </h2>
          {body}
        </section>
        <div className="grid gap-5">
          {canManage && <NewTeamCard />}
          <MembersCard />
        </div>
      </div>
    </>
  );
}
