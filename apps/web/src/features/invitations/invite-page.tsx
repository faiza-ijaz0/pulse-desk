import {
  invitationTokenSchema,
  registerWithInvitationRequestSchema,
  type AuthSession,
  type InvitationPreview,
} from '@pulsedesk/shared';
import { LogOut, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Alert, Skeleton } from '@/components/ui/misc';
import { AuthLayout } from '@/features/auth/auth-layout';
import {
  PasswordInput,
  describeAuthError,
  focusFirstInvalid,
  issuesByField,
} from '@/features/auth/form-helpers';
import { ROLE_LABELS } from '@/features/auth/role-label';
import { useLogout, useSessionQuery } from '@/features/auth/session';
import { ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format-time';
import {
  useAcceptInvitation,
  useInvitationPreview,
  useRegisterWithInvitation,
  useSignInAndAccept,
} from './api';

function tokenFromHash(): string | null {
  const raw = window.location.hash.slice(1);
  return invitationTokenSchema.safeParse(raw).success ? raw : null;
}

/**
 * The token from the link's fragment (`/invite#<token>`). Fragments never reach a server or a
 * Referer header; the address bar is cleaned at once so the token doesn't linger in history or
 * screenshots. Opening another link while on this page changes only the fragment (no reload),
 * so `hashchange` picks it up.
 */
function useLinkToken(): string | null {
  const [token, setToken] = useState(tokenFromHash);
  useEffect(() => {
    const take = () => {
      if (!window.location.hash) return;
      setToken(tokenFromHash());
      window.history.replaceState(window.history.state, '', window.location.pathname);
    };
    take();
    window.addEventListener('hashchange', take);
    return () => window.removeEventListener('hashchange', take);
  }, []);
  return token;
}

const signInLink = (
  <Link to="/login" className="font-medium text-accent-subtle-foreground hover:underline">
    Go to sign in
  </Link>
);

function Summary({ preview }: { preview: InvitationPreview }) {
  return (
    <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-y-2 rounded-xl border border-border bg-surface-sunken/50 px-4 py-3 text-sm">
      <dt className="text-muted-foreground">Organization</dt>
      <dd className="truncate font-medium">{preview.organizationName}</dd>
      <dt className="text-muted-foreground">Email</dt>
      <dd className="truncate">{preview.email}</dd>
      <dt className="text-muted-foreground">Role</dt>
      <dd>
        <Badge tone={preview.role === 'ADMIN' ? 'accent' : 'neutral'}>
          {ROLE_LABELS[preview.role]}
        </Badge>
      </dd>
      <dt className="text-muted-foreground">Expires</dt>
      <dd>{formatDateTime(preview.expiresAt)}</dd>
    </dl>
  );
}

function AcceptStep({ token, onJoined }: { token: string; onJoined: () => void }) {
  const accept = useAcceptInvitation();
  return (
    <div className="grid gap-4">
      {accept.isError && (
        <Alert tone="danger" title="Couldn’t accept the invitation">
          {describeAuthError(accept.error)}
        </Alert>
      )}
      <Button
        size="lg"
        className="w-full"
        loading={accept.isPending}
        onClick={() => accept.mutate(token, { onSuccess: onJoined })}
      >
        Accept and join
      </Button>
    </div>
  );
}

function SignUpForm({
  token,
  preview,
  onJoined,
  onHasAccount,
}: {
  token: string;
  preview: InvitationPreview;
  onJoined: () => void;
  onHasAccount: () => void;
}) {
  const register = useRegisterWithInvitation();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState({ name: '', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = registerWithInvitationRequestSchema.safeParse({ token, ...values });
    const next = result.success ? {} : issuesByField(result.error);
    if (values.password.trim().toLowerCase() === preview.email) {
      next.password = 'Your password can’t be your email address';
    }
    setErrors(next);
    if (!result.success || next.password) {
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    register.mutate(result.data, {
      onSuccess: onJoined,
      onError: (error) => {
        if (error instanceof ApiError && error.code === 'EMAIL_TAKEN') onHasAccount();
      },
    });
  }

  return (
    <form
      ref={formRef}
      aria-label="Create your account"
      noValidate
      onSubmit={onSubmit}
      className="grid gap-5"
      aria-busy={register.isPending}
    >
      {register.isError && (
        <Alert tone="danger" title="Couldn’t create your account">
          {describeAuthError(register.error)}
        </Alert>
      )}
      <Field label="Email" description="Set by the invitation.">
        {(control) => <Input {...control} type="email" value={preview.email} readOnly />}
      </Field>
      <Field label="Your name" error={errors.name} required>
        {(control) => (
          <Input
            {...control}
            autoComplete="name"
            value={values.name}
            disabled={register.isPending}
            onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
          />
        )}
      </Field>
      <Field
        label="Password"
        description="At least 12 characters."
        error={errors.password}
        required
      >
        {(control) => (
          <PasswordInput
            {...control}
            autoComplete="new-password"
            value={values.password}
            disabled={register.isPending}
            onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))}
          />
        )}
      </Field>
      <Button type="submit" size="lg" className="w-full" loading={register.isPending}>
        <UserPlus aria-hidden="true" />
        Create account and join
      </Button>
    </form>
  );
}

function SignInForm({
  token,
  preview,
  notice,
  onJoined,
}: {
  token: string;
  preview: InvitationPreview;
  notice: string | undefined;
  onJoined: () => void;
}) {
  const join = useSignInAndAccept();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const failure = join.error;

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password === '') {
      setError('Enter your password');
      return;
    }
    setError(undefined);
    join.mutate(
      { email: preview.email, password, token },
      { onSuccess: onJoined, onError: () => setPassword('') },
    );
  }

  return (
    <form
      aria-label="Sign in to accept"
      noValidate
      onSubmit={onSubmit}
      className="grid gap-5"
      aria-busy={join.isPending}
    >
      {notice && !failure && (
        <Alert tone="info" title="You already have an account">
          {notice}
        </Alert>
      )}
      {failure && (
        <Alert tone="danger" title="Couldn’t accept the invitation">
          {describeAuthError(failure)}
        </Alert>
      )}
      <Field label="Email" description="Set by the invitation.">
        {(control) => <Input {...control} type="email" value={preview.email} readOnly />}
      </Field>
      <Field label="Password" error={error} required>
        {(control) => (
          <PasswordInput
            {...control}
            autoComplete="current-password"
            value={password}
            disabled={join.isPending}
            onChange={(e) => setPassword(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" size="lg" className="w-full" loading={join.isPending}>
        Sign in and join
      </Button>
    </form>
  );
}

function SignedOutSteps({
  token,
  preview,
  onJoined,
}: {
  token: string;
  preview: InvitationPreview;
  onJoined: () => void;
}) {
  const [mode, setMode] = useState<'signup' | 'signin'>('signup');
  const [notice, setNotice] = useState<string>();
  return (
    <div className="grid gap-5">
      <div
        role="group"
        aria-label="How do you want to join?"
        className="grid grid-cols-2 gap-1 rounded-lg bg-surface-sunken p-1"
      >
        {(
          [
            ['signup', 'I’m new here'],
            ['signin', 'I have an account'],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={mode === value ? 'secondary' : 'ghost'}
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      {mode === 'signup' ? (
        <SignUpForm
          token={token}
          preview={preview}
          onJoined={onJoined}
          onHasAccount={() => {
            setNotice('Sign in with your password to accept the invitation.');
            setMode('signin');
          }}
        />
      ) : (
        <SignInForm token={token} preview={preview} notice={notice} onJoined={onJoined} />
      )}
    </div>
  );
}

function SignedInSteps({
  token,
  preview,
  session,
  onJoined,
}: {
  token: string;
  preview: InvitationPreview;
  session: AuthSession;
  onJoined: () => void;
}) {
  const logout = useLogout();
  if (session.user.email === preview.email) return <AcceptStep token={token} onJoined={onJoined} />;
  return (
    <div className="grid gap-4">
      <Alert tone="warning" title="This invitation is for someone else">
        You’re signed in as {session.user.email}, but the invitation was sent to {preview.email}.
        Sign out, then sign in or create an account with that email.
      </Alert>
      <Button variant="secondary" loading={logout.isPending} onClick={() => logout.mutate()}>
        <LogOut aria-hidden="true" />
        Sign out
      </Button>
    </div>
  );
}

export function InvitePage() {
  const navigate = useNavigate();
  const token = useLinkToken();
  const preview = useInvitationPreview(token);
  const session = useSessionQuery();
  const onJoined = () => void navigate('/dashboard', { replace: true });

  if (token === null) {
    return (
      <AuthLayout
        title="This invitation link is incomplete"
        description="Open the full link you were sent, or ask for a new invitation."
        footer={signInLink}
      >
        <span />
      </AuthLayout>
    );
  }
  if (preview.isError) {
    return (
      <AuthLayout
        title="This invitation can’t be used"
        description={describeAuthError(preview.error)}
        footer={signInLink}
      >
        <span />
      </AuthLayout>
    );
  }
  if (preview.isPending || session.isPending) {
    return (
      <AuthLayout title="Opening your invitation…" description="One moment." footer={signInLink}>
        <div className="grid gap-3">
          <span role="status" className="sr-only">
            Loading the invitation…
          </span>
          <Skeleton className="h-32" />
          <Skeleton className="h-10" />
        </div>
      </AuthLayout>
    );
  }

  const invitation = preview.data;
  return (
    <AuthLayout
      title={`Join ${invitation.organizationName}`}
      description={`${invitation.invitedByName ?? 'An admin'} invited you to work in ${invitation.organizationName} on PulseDesk.`}
      footer={<>Not expecting this? You can ignore it; it expires on its own.</>}
    >
      <div className="grid gap-6">
        <Summary preview={invitation} />
        {session.data ? (
          <SignedInSteps
            token={token}
            preview={invitation}
            session={session.data}
            onJoined={onJoined}
          />
        ) : (
          <SignedOutSteps token={token} preview={invitation} onJoined={onJoined} />
        )}
      </div>
    </AuthLayout>
  );
}
