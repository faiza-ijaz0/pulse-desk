import { loginRequestSchema } from '@pulsedesk/shared';
import { useRef, useState, type SubmitEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { AuthLayout } from './auth-layout';
import { describeAuthError, focusFirstInvalid, issuesByField, PasswordInput } from './form-helpers';
import { useLogin, useSessionQuery } from './session';

/**
 * Where to go after signing in: the page that sent the visitor here, if it is an in-app
 * path. Anything else (absolute or protocol-relative URLs) is ignored — no open redirects.
 */
export function safeRedirectTarget(state: unknown): string {
  const from =
    typeof state === 'object' && state !== null && 'from' in state ? state.from : undefined;
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//')
    ? from
    : '/dashboard';
}

export function LoginPage() {
  const location = useLocation();
  const session = useSessionQuery();
  const login = useLogin();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const target = safeRedirectTarget(location.state);

  // Covers both arriving already signed in and the moment a sign-in succeeds.
  if (session.data) return <Navigate to={target} replace />;

  function update(name: keyof typeof values, value: string) {
    const next = { ...values, [name]: value };
    setValues(next);
    if (submitted) {
      const result = loginRequestSchema.safeParse(next);
      setErrors(result.success ? {} : issuesByField(result.error));
    }
  }

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    const result = loginRequestSchema.safeParse(values);
    if (!result.success) {
      setErrors(issuesByField(result.error));
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    setErrors({});
    login.mutate(result.data, {
      onError: () => setValues((v) => ({ ...v, password: '' })),
    });
  }

  return (
    <AuthLayout
      title="Sign in to PulseDesk"
      description="Welcome back. Enter your work email and password."
      footer={
        <>
          New to PulseDesk?{' '}
          <Link to="/signup" className="font-medium text-accent-subtle-foreground hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form
        ref={formRef}
        noValidate
        onSubmit={onSubmit}
        className="grid gap-5"
        aria-busy={login.isPending}
      >
        {login.isError && (
          <Alert tone="danger" title="Couldn’t sign you in">
            {describeAuthError(login.error)}
          </Alert>
        )}
        <Field label="Email" error={errors.email} required>
          {(control) => (
            <Input
              {...control}
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              value={values.email}
              onChange={(e) => update('email', e.target.value)}
              disabled={login.isPending}
            />
          )}
        </Field>
        <Field label="Password" error={errors.password} required>
          {(control) => (
            <PasswordInput
              {...control}
              name="password"
              autoComplete="current-password"
              value={values.password}
              onChange={(e) => update('password', e.target.value)}
              disabled={login.isPending}
            />
          )}
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthLayout>
  );
}
