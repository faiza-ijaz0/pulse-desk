import { Building2, LogOut } from 'lucide-react';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { ErrorState } from '@/components/common/states';
import { BrandMark } from '@/components/layout/brand';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/misc';
import { Spinner } from '@/components/ui/spinner';
import { ApiUnavailableError } from '@/lib/api-client';
import { describeAuthError } from './form-helpers';
import {
  SessionProvider,
  useLogout,
  useSessionQuery,
  useSwitchOrganization,
  type ActiveSession,
} from './session';

function FullScreen({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-4 py-10">
      {children}
    </main>
  );
}

/**
 * Shown when the user is signed in but no longer belongs to the organization their session
 * points at (they were removed). They pick one of their remaining organizations or sign out.
 */
function ChooseOrganization({
  session,
}: {
  session: NonNullable<ReturnType<typeof useSessionQuery>['data']>;
}) {
  const switchOrganization = useSwitchOrganization();
  const logout = useLogout();

  return (
    <FullScreen>
      <Card className="w-full max-w-md">
        <CardHeader className="flex-col items-start">
          <BrandMark className="mb-2" />
          <CardTitle>
            {session.organizations.length > 0 ? 'Choose an organization' : 'No organization access'}
          </CardTitle>
          <CardDescription>
            {session.organizations.length > 0
              ? 'You no longer have access to the organization you were using. Continue in another one.'
              : `You’re signed in as ${session.user.email}, but you aren’t a member of any organization anymore. Ask an owner to invite you again.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          {switchOrganization.isError && (
            <Alert tone="danger" title="Couldn’t switch organization">
              {describeAuthError(switchOrganization.error)}
            </Alert>
          )}
          {session.organizations.map((organization) => (
            <Button
              key={organization.id}
              variant="secondary"
              className="justify-start"
              loading={
                switchOrganization.isPending && switchOrganization.variables === organization.id
              }
              disabled={switchOrganization.isPending}
              onClick={() => switchOrganization.mutate(organization.id)}
            >
              <Building2 aria-hidden="true" />
              {organization.name}
            </Button>
          ))}
          <Button variant="ghost" onClick={() => logout.mutate()} loading={logout.isPending}>
            <LogOut aria-hidden="true" />
            Sign out
          </Button>
        </CardContent>
      </Card>
    </FullScreen>
  );
}

/**
 * Layout guard for the signed-in app. The session comes from `GET /api/v1/auth/session`
 * (the browser sends the HttpOnly cookie); nothing about it is kept in browser storage.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const session = useSessionQuery();
  const location = useLocation();

  if (session.isPending) {
    return (
      <FullScreen>
        <div
          role="status"
          className="flex flex-col items-center gap-4 text-sm text-muted-foreground"
        >
          <BrandMark className="size-9" />
          <span className="flex items-center gap-2">
            <Spinner />
            Restoring your session…
          </span>
        </div>
      </FullScreen>
    );
  }

  if (session.isError) {
    // No API answered (offline, or a frontend-only deployment): the sign-in page explains it.
    if (session.error instanceof ApiUnavailableError) {
      return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    }
    return (
      <FullScreen>
        <ErrorState
          className="w-full max-w-md"
          title="We couldn’t load your session"
          description={describeAuthError(session.error)}
          onRetry={() => void session.refetch()}
          retrying={session.isFetching}
        />
      </FullScreen>
    );
  }

  if (session.data === null) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  const { activeOrganization } = session.data;
  if (activeOrganization === null) return <ChooseOrganization session={session.data} />;

  const active: ActiveSession = { ...session.data, activeOrganization };
  return <SessionProvider session={active}>{children}</SessionProvider>;
}
