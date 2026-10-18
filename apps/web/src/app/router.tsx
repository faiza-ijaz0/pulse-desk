import { Navigate, createBrowserRouter, type RouteObject } from 'react-router';
import { AppShell } from '@/components/layout/app-shell';
import { RequireAuth } from '@/features/auth/require-auth';
import { NotFoundPage, RouteErrorPage } from '@/pages/not-found-page';
import { PlannedPage } from '@/pages/planned-page';
import { NAV_ITEMS } from './navigation';

// Pages are code-split: each route's module loads on first visit, keeping the
// initial bundle to the shell and shared vendor code.
export const routes: RouteObject[] = [
  {
    path: '/login',
    errorElement: <RouteErrorPage />,
    lazy: async () => ({ Component: (await import('@/features/auth/login-page')).LoginPage }),
  },
  {
    path: '/signup',
    errorElement: <RouteErrorPage />,
    lazy: async () => ({ Component: (await import('@/features/auth/signup-page')).SignupPage }),
  },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      {
        path: 'dashboard',
        lazy: async () => ({
          Component: (await import('@/features/dashboard/dashboard-page')).DashboardPage,
        }),
      },
      {
        path: 'design-system',
        lazy: async () => ({
          Component: (await import('@/pages/design-system-page')).DesignSystemPage,
        }),
      },
      ...NAV_ITEMS.filter((item) => item.status === 'planned').map((item) => ({
        path: item.to.slice(1),
        element: <PlannedPage item={item} />,
      })),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
