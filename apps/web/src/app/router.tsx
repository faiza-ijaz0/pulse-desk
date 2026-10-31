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
    // Public: an invitation link works signed in or out (the token is in the fragment).
    path: '/invite',
    errorElement: <RouteErrorPage />,
    lazy: async () => ({
      Component: (await import('@/features/invitations/invite-page')).InvitePage,
    }),
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
        path: 'tickets',
        lazy: async () => ({
          Component: (await import('@/features/tickets/ticket-inbox-page')).TicketInboxPage,
        }),
      },
      {
        path: 'tickets/:number',
        lazy: async () => ({
          Component: (await import('@/features/tickets/ticket-detail-page')).TicketDetailPage,
        }),
      },
      {
        path: 'customers',
        lazy: async () => ({
          Component: (await import('@/features/customers/customers-page')).CustomersPage,
        }),
      },
      {
        path: 'customers/:customerId',
        lazy: async () => ({
          Component: (await import('@/features/customers/customer-detail-page')).CustomerDetailPage,
        }),
      },
      {
        path: 'team',
        lazy: async () => ({ Component: (await import('@/features/team/team-page')).TeamPage }),
      },
      {
        path: 'sla',
        lazy: async () => ({
          Component: (await import('@/features/sla/sla-policy-page')).SlaPolicyPage,
        }),
      },
      {
        path: 'settings',
        lazy: async () => ({
          Component: (await import('@/features/settings/settings-page')).SettingsPage,
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
