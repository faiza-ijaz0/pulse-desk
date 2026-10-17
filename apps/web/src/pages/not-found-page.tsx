import { Compass } from 'lucide-react';
import { Link, isRouteErrorResponse, useRouteError } from 'react-router';
import { EmptyState, ErrorState } from '@/components/common/states';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  return (
    <EmptyState
      icon={Compass}
      title="Page not found"
      description="The page you’re looking for doesn’t exist or may have moved."
      className="mt-10"
    >
      <Button asChild size="sm">
        <Link to="/dashboard">Go to dashboard</Link>
      </Button>
    </EmptyState>
  );
}

/** Router-level error boundary: a rendering failure shows a recoverable screen, not a blank page. */
export function RouteErrorPage() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;

  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <ErrorState
        title="This page failed to load"
        description="An unexpected error occurred while rendering. Reloading usually fixes it; if it keeps happening, please report it."
        onRetry={() => window.location.reload()}
      />
    </div>
  );
}
