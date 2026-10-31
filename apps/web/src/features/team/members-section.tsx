import {
  INVITABLE_ROLES,
  ROLES,
  canManageRole,
  createInvitationRequestSchema,
  hasPermission,
  type InvitableRole,
  type Invitation,
  type Member,
  type Role,
} from '@pulsedesk/shared';
import { Check, Copy, Link2, MailPlus, UserMinus } from 'lucide-react';
import { useRef, useState, type SubmitEvent } from 'react';
import { useNavigate } from 'react-router';
import { EmptyState } from '@/components/common/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Avatar, Skeleton } from '@/components/ui/misc';
import { NativeSelect } from '@/components/ui/select';
import { describeAuthError, issuesByField } from '@/features/auth/form-helpers';
import { ROLE_LABELS } from '@/features/auth/role-label';
import { useActiveSession } from '@/features/auth/session';
import { useMemberOptions } from '@/features/tickets/api';
import { ApiError } from '@/lib/api-client';
import { formatDateTime, formatRelative } from '@/lib/format-time';
import {
  useChangeMemberRole,
  useCreateInvitation,
  useInvitations,
  useRemoveMember,
  useRevokeInvitation,
} from './api';

const ROLE_TONES: Record<Role, 'magenta' | 'accent' | 'neutral'> = {
  OWNER: 'magenta',
  ADMIN: 'accent',
  AGENT: 'neutral',
};

const ROLE_HINTS: Record<InvitableRole, string> = {
  ADMIN: 'Manages members, teams, tags, SLA targets and settings.',
  AGENT: 'Works tickets and customers.',
};

// Most privileged first, as the selects list them.
const ROLE_ORDER = [...ROLES];

function RoleBadge({ role }: { role: Role }) {
  return <Badge tone={ROLE_TONES[role]}>{ROLE_LABELS[role]}</Badge>;
}

/** Whether `actor` may change or remove `target`: the API's own rule (members.policy.ts). */
function canManage(actor: Role, target: Member) {
  return canManageRole(actor, target.role);
}

// ───────────────────────── Members ─────────────────────────

type PendingChange = { member: Member; role: Role } | null;

function MemberRow({
  member,
  isSelf,
  actorRole,
  onRequestRole,
  onRequestRemove,
  rowError,
  pending,
}: {
  member: Member;
  isSelf: boolean;
  actorRole: Role;
  onRequestRole: (role: Role) => void;
  onRequestRemove: () => void;
  rowError: string | undefined;
  pending: boolean;
}) {
  const manageable = canManage(actorRole, member);
  const grantable = ROLE_ORDER.filter((role) => canManageRole(actorRole, role));
  const errorId = `member-${member.userId}-error`;
  return (
    <tr className="align-middle">
      <th scope="row" className="py-3 pr-3 text-left font-normal">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={member.name} size="sm" className="ring-0" />
          <div className="min-w-0">
            <p className="flex items-center gap-2 truncate text-sm font-medium">
              <span className="truncate">{member.name}</span>
              {isSelf && <Badge tone="info">You</Badge>}
            </p>
            <p className="truncate text-xs text-muted-foreground">{member.email}</p>
            {rowError && (
              <p id={errorId} role="alert" className="mt-1 text-xs text-danger-foreground">
                {rowError}
              </p>
            )}
          </div>
        </div>
      </th>
      <td className="py-3 pr-3">
        {manageable ? (
          <NativeSelect
            aria-label={`Role for ${member.name}`}
            aria-describedby={rowError ? errorId : undefined}
            className="h-8 w-32"
            value={member.role}
            disabled={pending}
            onChange={(event) => onRequestRole(event.target.value as Role)}
          >
            {grantable.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </NativeSelect>
        ) : (
          <RoleBadge role={member.role} />
        )}
      </td>
      <td className="hidden py-3 pr-3 text-sm text-muted-foreground md:table-cell">
        {formatDateTime(member.joinedAt)}
      </td>
      <td className="py-3 text-right">
        {manageable && (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            aria-label={isSelf ? 'Leave organization' : `Remove ${member.name}`}
            onClick={onRequestRemove}
          >
            <UserMinus aria-hidden="true" />
            <span className="hidden sm:inline">{isSelf ? 'Leave' : 'Remove'}</span>
          </Button>
        )}
      </td>
    </tr>
  );
}

function MembersCard() {
  const navigate = useNavigate();
  const { user, activeOrganization } = useActiveSession();
  const members = useMemberOptions();
  const changeRole = useChangeMemberRole();
  const remove = useRemoveMember();
  const [confirmRole, setConfirmRole] = useState<PendingChange>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string>();

  function applyRole(member: Member, role: Role) {
    setRowErrors(({ [member.userId]: _cleared, ...others }) => others);
    setSaved(undefined);
    changeRole.mutate(
      { userId: member.userId, role },
      {
        onSuccess: () => {
          setConfirmRole(null);
          setSaved(`${member.name} is now ${ROLE_LABELS[role].toLowerCase()}.`);
        },
        onError: (error) => {
          setConfirmRole(null);
          setRowErrors((errors) => ({ ...errors, [member.userId]: describeAuthError(error) }));
        },
      },
    );
  }

  function requestRole(member: Member, role: Role) {
    if (role === member.role) return;
    // Giving away your own rights, or granting ownership, deserves a second look.
    if (member.userId === user.id || role === 'OWNER') setConfirmRole({ member, role });
    else applyRole(member, role);
  }

  const removingSelf = removing?.userId === user.id;

  return (
    <Card aria-labelledby="members-title">
      <CardHeader>
        <CardTitle id="members-title">Members</CardTitle>
        <CardDescription>
          {members.isSuccess
            ? `${members.data.length} ${members.data.length === 1 ? 'person' : 'people'} in ${activeOrganization.name}.`
            : 'Everyone in this organization and their role.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {members.isPending ? (
          <div className="grid gap-2">
            <span role="status" className="sr-only">
              Loading members…
            </span>
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : members.isError ? (
          <p role="alert" className="text-sm text-danger-foreground">
            {describeAuthError(members.error)}
          </p>
        ) : (
          <>
            <table className="w-full table-fixed text-sm">
              <caption className="sr-only">Organization members</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="w-[55%] py-2 pr-3 font-medium md:w-auto">
                    Member
                  </th>
                  <th scope="col" className="w-36 py-2 pr-3 font-medium">
                    Role
                  </th>
                  <th scope="col" className="hidden w-44 py-2 pr-3 font-medium md:table-cell">
                    Joined
                  </th>
                  <th scope="col" className="w-12 py-2 font-medium sm:w-28">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {members.data.map((member) => (
                  <MemberRow
                    key={member.userId}
                    member={member}
                    isSelf={member.userId === user.id}
                    actorRole={activeOrganization.role}
                    rowError={rowErrors[member.userId]}
                    pending={
                      (changeRole.isPending && changeRole.variables.userId === member.userId) ||
                      (remove.isPending && remove.variables === member.userId)
                    }
                    onRequestRole={(role) => requestRole(member, role)}
                    onRequestRemove={() => {
                      remove.reset();
                      setRemoving(member);
                    }}
                  />
                ))}
              </tbody>
            </table>
            <p role="status" className="mt-3 min-h-4 text-xs text-success-foreground">
              {saved && (
                <span className="inline-flex items-center gap-1">
                  <Check className="size-3.5" aria-hidden="true" />
                  {saved}
                </span>
              )}
            </p>
          </>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmRole !== null}
        onOpenChange={(open) => !open && setConfirmRole(null)}
        title={
          confirmRole?.role === 'OWNER'
            ? `Make ${confirmRole.member.name} an owner?`
            : 'Change your own role?'
        }
        description={
          confirmRole?.role === 'OWNER'
            ? 'Owners can do everything, including managing other owners. Only an owner can undo this.'
            : `You’ll become ${confirmRole ? ROLE_LABELS[confirmRole.role].toLowerCase() : ''} and lose the permissions you have now. Only someone with a higher role can change it back.${confirmRole?.role === 'AGENT' ? ' Your open invitations are revoked.' : ''}`
        }
        confirmLabel="Change role"
        pending={changeRole.isPending}
        onConfirm={() => confirmRole && applyRole(confirmRole.member, confirmRole.role)}
      />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={
          removingSelf ? `Leave ${activeOrganization.name}?` : `Remove ${removing?.name ?? ''}?`
        }
        description={
          removingSelf
            ? 'You’ll lose access to this organization at once, and your open invitations are revoked. Someone will have to invite you again to come back.'
            : 'They lose access to this organization at once, their assigned tickets become unassigned and their open invitations are revoked. Their account and other organizations are not affected.'
        }
        confirmLabel={removingSelf ? 'Leave organization' : 'Remove member'}
        pending={remove.isPending}
        error={remove.isError ? describeAuthError(remove.error) : undefined}
        onConfirm={() =>
          removing &&
          remove.mutate(removing.userId, {
            onSuccess: () => {
              setSaved(removingSelf ? undefined : `${removing.name} was removed.`);
              setRemoving(null);
              if (removingSelf) void navigate('/dashboard', { replace: true });
            },
          })
        }
      />
    </Card>
  );
}

// ───────────────────────── Invitations ─────────────────────────

function inviteLink(token: string): string {
  // The token rides in the fragment, which browsers never send to servers or in Referer.
  return `${window.location.origin}/invite#${token}`;
}

/** The invite button and its dialog: as the dialog's trigger, the button gets focus back on close. */
function InviteDialog() {
  const [open, setOpen] = useState(false);
  const create = useCreateInvitation();
  const [values, setValues] = useState<{ email: string; role: InvitableRole }>({
    email: '',
    role: 'AGENT',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const linkRef = useRef<HTMLInputElement>(null);
  const created = create.data;

  function close(next: boolean) {
    if (create.isPending) return;
    setOpen(next);
    if (!next) {
      // Forget the link: it is shown once.
      create.reset();
      setValues({ email: '', role: 'AGENT' });
      setErrors({});
      setCopied(false);
    }
  }

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = createInvitationRequestSchema.safeParse(values);
    if (!result.success) {
      setErrors(issuesByField(result.error));
      return;
    }
    setErrors({});
    create.mutate(result.data);
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(inviteLink(created.token));
      setCopied(true);
    } catch {
      // Clipboard access can be refused; select the link so it can be copied by hand.
      linkRef.current?.select();
    }
  }

  const serverError = create.error instanceof ApiError ? create.error : undefined;
  const emailError =
    errors.email ??
    (serverError?.code === 'ALREADY_MEMBER'
      ? serverError.message
      : serverError?.fieldErrors.find((e) => e.path === 'body.email')?.message);
  const otherError = create.isError && !emailError ? describeAuthError(create.error) : undefined;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button size="sm">
          <MailPlus aria-hidden="true" />
          Invite member
        </Button>
      </DialogTrigger>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Invitation ready</DialogTitle>
              <DialogDescription>
                Share it only with {created.invitation.email}: anyone with this link can join as{' '}
                {created.invitation.email} ({ROLE_LABELS[created.invitation.role].toLowerCase()})
                until it’s used, revoked or expires.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <Field
                label="Invitation link"
                description={`Shown once — it can’t be retrieved later. Expires ${formatDateTime(created.invitation.expiresAt)}.`}
              >
                {(control) => (
                  <div className="flex gap-2">
                    <Input
                      {...control}
                      ref={linkRef}
                      readOnly
                      value={inviteLink(created.token)}
                      onFocus={(event) => event.target.select()}
                      className="font-mono text-xs"
                    />
                    <Button type="button" variant="secondary" onClick={() => void copy()}>
                      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                )}
              </Field>
              <p role="status" className="sr-only">
                {copied ? 'Link copied to the clipboard.' : ''}
              </p>
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => close(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form aria-label="Invite a member" noValidate onSubmit={onSubmit} className="grid gap-5">
            <DialogHeader>
              <DialogTitle>Invite a member</DialogTitle>
              <DialogDescription>
                You’ll get a link to send them yourself. It works once, for 7 days, and joins them
                under the email you enter.
              </DialogDescription>
            </DialogHeader>
            <Field label="Email" error={emailError} required>
              {(control) => (
                <Input
                  {...control}
                  type="email"
                  autoComplete="off"
                  inputMode="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={values.email}
                  disabled={create.isPending}
                  onChange={(event) => {
                    setValues((v) => ({ ...v, email: event.target.value }));
                    setErrors((e) => ({ ...e, email: '' }));
                    create.reset();
                  }}
                />
              )}
            </Field>
            <Field label="Role" description={ROLE_HINTS[values.role]} error={errors.role} required>
              {(control) => (
                <NativeSelect
                  {...control}
                  value={values.role}
                  disabled={create.isPending}
                  onChange={(event) =>
                    setValues((v) => ({ ...v, role: event.target.value as InvitableRole }))
                  }
                >
                  {INVITABLE_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            {otherError && (
              <p
                role="alert"
                className="rounded-md border border-danger/25 bg-danger-subtle px-3 py-2 text-sm text-danger-foreground"
              >
                {otherError}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                disabled={create.isPending}
                onClick={() => close(false)}
              >
                Cancel
              </Button>
              <Button type="submit" loading={create.isPending}>
                <Link2 aria-hidden="true" />
                Create invitation
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function InvitationRow({ invitation, onRevoke }: { invitation: Invitation; onRevoke: () => void }) {
  const expired = invitation.status === 'expired';
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{invitation.email}</p>
        <p className="text-xs text-muted-foreground">
          {invitation.invitedBy ? `Invited by ${invitation.invitedBy.name} · ` : ''}
          {expired
            ? `Expired ${formatDateTime(invitation.expiresAt)}`
            : `Expires ${formatRelative(invitation.expiresAt)}`}
        </p>
      </div>
      <RoleBadge role={invitation.role} />
      <Badge tone={expired ? 'warning' : 'success'} dot>
        {expired ? 'Expired' : 'Pending'}
      </Badge>
      <Button
        variant="ghost"
        size="sm"
        onClick={onRevoke}
        aria-label={`Revoke invitation for ${invitation.email}`}
      >
        Revoke
      </Button>
    </li>
  );
}

function InvitationsCard() {
  const invitations = useInvitations(true);
  const revoke = useRevokeInvitation();
  const [revoking, setRevoking] = useState<Invitation | null>(null);

  return (
    <Card aria-labelledby="invitations-title">
      <CardHeader>
        <CardTitle id="invitations-title">Invitations</CardTitle>
        <CardDescription>Links that haven’t been accepted yet.</CardDescription>
      </CardHeader>
      <CardContent>
        {invitations.isPending ? (
          <div className="grid gap-2">
            <span role="status" className="sr-only">
              Loading invitations…
            </span>
            <Skeleton className="h-12" />
          </div>
        ) : invitations.isError ? (
          <div className="grid justify-items-start gap-2">
            <p role="alert" className="text-sm text-danger-foreground">
              {describeAuthError(invitations.error)}
            </p>
            <Button
              variant="secondary"
              size="sm"
              loading={invitations.isRefetching}
              onClick={() => void invitations.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : invitations.data.length === 0 ? (
          <EmptyState
            icon={MailPlus}
            title="No open invitations"
            description="Invite someone to give them access to this organization."
            className="border-0 py-6 shadow-none"
          />
        ) : (
          <ul aria-label="Open invitations" className="divide-y divide-border">
            {invitations.data.map((invitation) => (
              <InvitationRow
                key={invitation.id}
                invitation={invitation}
                onRevoke={() => {
                  revoke.reset();
                  setRevoking(invitation);
                }}
              />
            ))}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title="Revoke this invitation?"
        description={`The link sent to ${revoking?.email ?? ''} stops working at once. You can invite them again later.`}
        confirmLabel="Revoke invitation"
        pending={revoke.isPending}
        error={revoke.isError ? describeAuthError(revoke.error) : undefined}
        onConfirm={() =>
          revoking && revoke.mutate(revoking.id, { onSuccess: () => setRevoking(null) })
        }
      />
    </Card>
  );
}

/** Members (everyone can see them) and, for admins and owners, invitations. */
export function MembersSection() {
  const { activeOrganization } = useActiveSession();
  const canInvite = hasPermission(activeOrganization.role, 'member:invite');

  return (
    <section aria-labelledby="people-title" className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="people-title" className="text-base font-semibold">
          People
        </h2>
        {canInvite && <InviteDialog />}
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <MembersCard />
        {canInvite && <InvitationsCard />}
      </div>
    </section>
  );
}
