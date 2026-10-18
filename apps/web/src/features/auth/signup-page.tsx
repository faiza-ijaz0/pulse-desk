import { PASSWORD_MIN_LENGTH, registerRequestSchema } from '@pulsedesk/shared';
import { useRef, useState, type SubmitEvent } from 'react';
import { Link, Navigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { ApiError, fieldErrorsByName } from '@/lib/api-client';
import { AuthLayout } from './auth-layout';
import { describeAuthError, focusFirstInvalid, issuesByField, PasswordInput } from './form-helpers';
import { useRegister, useSessionQuery } from './session';

const EMPTY = { name: '', email: '', organizationName: '', password: '' };
type Values = typeof EMPTY;

export function SignupPage() {
  const session = useSessionQuery();
  const register = useRegister();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  // Arriving already signed in, or the moment registration succeeds.
  if (session.data) {
    return (
      <Navigate
        to="/dashboard"
        replace
        state={register.isSuccess ? { welcome: session.data.activeOrganization?.name } : undefined}
      />
    );
  }

  const emailTaken = register.error instanceof ApiError && register.error.code === 'EMAIL_TAKEN';

  function update(name: keyof Values, value: string) {
    const next = { ...values, [name]: value };
    setValues(next);
    if (submitted) {
      const result = registerRequestSchema.safeParse(next);
      setErrors(result.success ? {} : issuesByField(result.error));
    }
    if (name === 'email' && emailTaken) register.reset();
  }

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    const result = registerRequestSchema.safeParse(values);
    if (!result.success) {
      setErrors(issuesByField(result.error));
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    setErrors({});
    register.mutate(result.data, {
      onError: (error) => {
        if (error instanceof ApiError && error.fieldErrors.length > 0) {
          setErrors(fieldErrorsByName(error));
          requestAnimationFrame(() => focusFirstInvalid(formRef.current));
        }
      },
    });
  }

  const passwordLength = values.password.length;

  return (
    <AuthLayout
      title="Create your PulseDesk account"
      description="Set up your organization in under a minute. You’ll be its owner."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-accent-subtle-foreground hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form
        ref={formRef}
        noValidate
        onSubmit={onSubmit}
        className="grid gap-5"
        aria-busy={register.isPending}
      >
        {register.isError && !emailTaken && (
          <Alert tone="danger" title="Couldn’t create your account">
            {describeAuthError(register.error)}
          </Alert>
        )}
        <Field label="Your name" error={errors.name} required>
          {(control) => (
            <Input
              {...control}
              name="name"
              autoComplete="name"
              value={values.name}
              onChange={(e) => update('name', e.target.value)}
              disabled={register.isPending}
            />
          )}
        </Field>
        <Field
          label="Work email"
          error={
            emailTaken ? (
              <>
                An account with this email already exists.{' '}
                <Link to="/login" className="underline">
                  Sign in instead
                </Link>
              </>
            ) : (
              errors.email
            )
          }
          required
        >
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
              disabled={register.isPending}
            />
          )}
        </Field>
        <Field
          label="Organization name"
          description="Usually your company or team. You can rename it later."
          error={errors.organizationName}
          required
        >
          {(control) => (
            <Input
              {...control}
              name="organizationName"
              autoComplete="organization"
              value={values.organizationName}
              onChange={(e) => update('organizationName', e.target.value)}
              disabled={register.isPending}
            />
          )}
        </Field>
        <Field
          label="Password"
          description={
            passwordLength >= PASSWORD_MIN_LENGTH
              ? undefined
              : `At least ${PASSWORD_MIN_LENGTH} characters${passwordLength > 0 ? ` · ${PASSWORD_MIN_LENGTH - passwordLength} to go` : ''}. A memorable phrase works well.`
          }
          success={
            !errors.password && passwordLength >= PASSWORD_MIN_LENGTH ? 'Long enough' : undefined
          }
          error={errors.password}
          required
        >
          {(control) => (
            <PasswordInput
              {...control}
              name="password"
              autoComplete="new-password"
              value={values.password}
              onChange={(e) => update('password', e.target.value)}
              disabled={register.isPending}
            />
          )}
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={register.isPending}>
          {register.isPending ? 'Creating your account…' : 'Create account'}
        </Button>
      </form>
    </AuthLayout>
  );
}
