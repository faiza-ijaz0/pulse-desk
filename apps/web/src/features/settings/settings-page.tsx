import {
  TAG_COLORS,
  createTagRequestSchema,
  hasPermission,
  updateOrganizationRequestSchema,
  type Organization,
  type Tag,
  type TagColor,
} from '@pulsedesk/shared';
import { Check, Pencil, Tags, Trash2 } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';
import { EmptyState, ErrorState, PageHeader } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Alert, Skeleton } from '@/components/ui/misc';
import { NativeSelect } from '@/components/ui/select';
import { describeAuthError } from '@/features/auth/form-helpers';
import { useActiveSession } from '@/features/auth/session';
import { useTagOptions } from '@/features/tickets/api';
import { TagBadge } from '@/features/tickets/ticket-parts';
import { ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format-time';
import {
  useCreateTag,
  useDeleteTag,
  useOrganization,
  useRenameOrganization,
  useUpdateTag,
} from './api';

/** A field-level message for a refused name: validation errors and conflicts included. */
function fieldMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'CONFLICT') return error.message;
    if (error.fieldErrors[0]) return error.fieldErrors[0].message;
  }
  return describeAuthError(error);
}

// ───────────────────────── Organization profile ─────────────────────────

function ProfileForm({ organization }: { organization: Organization }) {
  const rename = useRenameOrganization();
  const [name, setName] = useState(organization.name);
  const [error, setError] = useState<string>();

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = updateOrganizationRequestSchema.safeParse({ name });
    if (!result.success) {
      setError(result.error.issues[0]?.message);
      return;
    }
    setError(undefined);
    rename.mutate(result.data);
  }

  return (
    <form aria-label="Organization profile" noValidate onSubmit={onSubmit} className="grid gap-4">
      <Field
        label="Organization name"
        description="Shown to everyone in this organization."
        error={error ?? (rename.isError ? fieldMessage(rename.error) : undefined)}
        required
      >
        {(control) => (
          <Input
            {...control}
            maxLength={100}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(undefined);
              rename.reset();
            }}
            disabled={rename.isPending}
          />
        )}
      </Field>
      <dl className="grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
        <dt className="text-muted-foreground">Workspace ID</dt>
        <dd className="font-mono text-xs leading-5">{organization.slug}</dd>
        <dt className="text-muted-foreground">Created</dt>
        <dd>{formatDateTime(organization.createdAt)}</dd>
      </dl>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" loading={rename.isPending}>
          Save changes
        </Button>
        <span role="status" className="text-xs text-success-foreground">
          {rename.isSuccess && (
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

function ProfileCard({ canEdit }: { canEdit: boolean }) {
  const organization = useOrganization();
  return (
    <Card aria-labelledby="profile-title">
      <CardHeader>
        <div>
          <CardTitle id="profile-title">Organization</CardTitle>
          <CardDescription>Your organization’s profile.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {organization.isPending ? (
          <Skeleton className="h-28" />
        ) : organization.isError ? (
          <ErrorState
            title="Couldn’t load the organization"
            description={describeAuthError(organization.error)}
            onRetry={() => void organization.refetch()}
            retrying={organization.isRefetching}
            className="border-0 py-6"
          />
        ) : canEdit ? (
          <ProfileForm organization={organization.data} />
        ) : (
          <dl className="grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{organization.data.name}</dd>
            <dt className="text-muted-foreground">Workspace ID</dt>
            <dd className="font-mono text-xs leading-5">{organization.data.slug}</dd>
            <dt className="text-muted-foreground">Created</dt>
            <dd>{formatDateTime(organization.data.createdAt)}</dd>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

// ───────────────────────── Tags ─────────────────────────

const COLOR_LABELS: Record<TagColor, string> = {
  violet: 'Violet',
  red: 'Red',
  blue: 'Blue',
  green: 'Green',
  amber: 'Amber',
};

function colorOf(value: string): TagColor | null {
  return TAG_COLORS.find((color) => color === value) ?? null;
}

function TagFields({
  name,
  color,
  error,
  pending,
  onName,
  onColor,
}: {
  name: string;
  color: TagColor | null;
  error: string | undefined;
  pending: boolean;
  onName: (name: string) => void;
  onColor: (color: TagColor | null) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
      <Field label="Tag name" error={error} className="content-start">
        {(control) => (
          <Input
            {...control}
            maxLength={40}
            value={name}
            onChange={(e) => onName(e.target.value)}
            disabled={pending}
          />
        )}
      </Field>
      <Field label="Color" className="content-start">
        {(control) => (
          <NativeSelect
            {...control}
            value={color ?? ''}
            onChange={(e) => onColor(colorOf(e.target.value))}
            disabled={pending}
          >
            <option value="">No color</option>
            {TAG_COLORS.map((value) => (
              <option key={value} value={value}>
                {COLOR_LABELS[value]}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
    </div>
  );
}

function NewTagForm() {
  const create = useCreateTag();
  const [name, setName] = useState('');
  const [color, setColor] = useState<TagColor | null>(null);
  const [error, setError] = useState<string>();

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = createTagRequestSchema.safeParse({ name, color });
    if (!result.success) {
      setError(result.error.issues[0]?.message);
      return;
    }
    setError(undefined);
    create.mutate(result.data, {
      onSuccess: () => {
        setName('');
        setColor(null);
      },
    });
  }

  return (
    <form
      aria-label="New tag"
      noValidate
      onSubmit={onSubmit}
      className="grid gap-3 border-t border-border pt-4"
    >
      <TagFields
        name={name}
        color={color}
        error={error ?? (create.isError ? fieldMessage(create.error) : undefined)}
        pending={create.isPending}
        onName={(value) => {
          setName(value);
          setError(undefined);
          create.reset();
        }}
        onColor={setColor}
      />
      <div>
        <Button type="submit" size="sm" loading={create.isPending}>
          Add tag
        </Button>
      </div>
    </form>
  );
}

function TagRow({ tag, canManage }: { tag: Tag; canManage: boolean }) {
  const update = useUpdateTag();
  const del = useDeleteTag();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState<TagColor | null>(colorOf(tag.color ?? ''));
  const [error, setError] = useState<string>();
  const usage =
    tag.ticketCount === 0
      ? 'Not used'
      : `${tag.ticketCount} ${tag.ticketCount === 1 ? 'ticket' : 'tickets'}`;

  if (editing) {
    return (
      <li className="py-3">
        <form
          aria-label={`Edit tag ${tag.name}`}
          noValidate
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const result = createTagRequestSchema.safeParse({ name, color });
            if (!result.success) {
              setError(result.error.issues[0]?.message);
              return;
            }
            update.mutate(
              { tagId: tag.id, ...result.data },
              { onSuccess: () => setEditing(false) },
            );
          }}
        >
          <TagFields
            name={name}
            color={color}
            error={error ?? (update.isError ? fieldMessage(update.error) : undefined)}
            pending={update.isPending}
            onName={(value) => {
              setName(value);
              setError(undefined);
              update.reset();
            }}
            onColor={setColor}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={update.isPending}>
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={update.isPending}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-3 py-2.5">
      <TagBadge tag={tag} />
      <span className="flex-1 text-xs text-muted-foreground">{usage}</span>
      {canManage && (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit ${tag.name}`}
            onClick={() => {
              setName(tag.name);
              setColor(colorOf(tag.color ?? ''));
              update.reset();
              setEditing(true);
            }}
          >
            <Pencil aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${tag.name}`}
            onClick={() => {
              del.reset();
              setConfirming(true);
            }}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete the tag “${tag.name}”?`}
        description={
          tag.ticketCount === 0
            ? 'No tickets use it. This can’t be undone.'
            : `It will be removed from ${usage}, and each ticket’s activity will record that. This can’t be undone.`
        }
        confirmLabel="Delete tag"
        pending={del.isPending}
        error={del.isError ? describeAuthError(del.error) : undefined}
        onConfirm={() => del.mutate(tag.id, { onSuccess: () => setConfirming(false) })}
      />
    </li>
  );
}

function TagsCard({ canManage }: { canManage: boolean }) {
  const tags = useTagOptions();
  return (
    <Card aria-labelledby="tags-title">
      <CardHeader>
        <div>
          <CardTitle id="tags-title">Tags</CardTitle>
          <CardDescription>Labels agents can put on tickets and filter by.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-2">
        {tags.isPending ? (
          <Skeleton className="h-24" />
        ) : tags.isError ? (
          <ErrorState
            title="Couldn’t load tags"
            description={describeAuthError(tags.error)}
            onRetry={() => void tags.refetch()}
            retrying={tags.isRefetching}
            className="border-0 py-6"
          />
        ) : tags.data.length === 0 ? (
          <EmptyState
            icon={Tags}
            title="No tags yet"
            description={canManage ? 'Add your first tag below.' : 'An admin can add tags.'}
            className="py-8"
          />
        ) : (
          <ul aria-label="Tags" className="divide-y divide-border">
            {tags.data.map((tag) => (
              <TagRow key={tag.id} tag={tag} canManage={canManage} />
            ))}
          </ul>
        )}
        {canManage && <NewTagForm />}
      </CardContent>
    </Card>
  );
}

export function SettingsPage() {
  const { activeOrganization } = useActiveSession();
  const canEditProfile = hasPermission(activeOrganization.role, 'organization:update');
  const canManageTags = hasPermission(activeOrganization.role, 'tag:manage');

  return (
    <>
      <PageHeader title="Settings" description="Your organization’s profile and ticket tags." />
      {!(canEditProfile && canManageTags) && (
        <Alert tone="info" title="View only" className="mb-4">
          Only admins and owners can change these settings.
        </Alert>
      )}
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <ProfileCard canEdit={canEditProfile} />
        <TagsCard canManage={canManageTags} />
      </div>
    </>
  );
}
