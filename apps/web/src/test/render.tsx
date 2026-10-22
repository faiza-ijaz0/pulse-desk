import { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { AppProviders, createQueryClient } from '@/app/providers';
import { routes } from '@/app/router';
import type { RetryPolicy } from '@/lib/retry';

/** Makes `(min-width: …)` queries match, i.e. simulates a desktop-width viewport. */
export function useDesktopViewport(prefersDark = false) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches:
          query.includes('min-width') ||
          (prefersDark && query.includes('prefers-color-scheme: dark')),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

export const HEALTHY = {
  status: 'ok',
  service: 'pulsedesk-api',
  version: '0.1.0',
  uptimeSeconds: 42,
  timestamp: '2026-10-16T09:00:00.000Z',
};

export const SIGNED_IN_SESSION = {
  user: {
    id: '0b7c4c1e-6a43-4c1e-9f3a-6f1c2a9d8e01',
    name: 'Maya Chen',
    email: 'maya@brightwave.test',
  },
  activeOrganization: {
    id: '5d2e9a10-3b7f-4a52-8c11-0e9b6f4d2a77',
    name: 'Brightwave Energy',
    slug: 'brightwave',
    role: 'OWNER',
  },
  organizations: [
    {
      id: '5d2e9a10-3b7f-4a52-8c11-0e9b6f4d2a77',
      name: 'Brightwave Energy',
      slug: 'brightwave',
      role: 'OWNER',
    },
    {
      id: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d',
      name: 'Kestrel Outfitters',
      slug: 'kestrel',
      role: 'AGENT',
    },
  ],
};

export function problem(status: number, code: string, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      type: 'about:blank',
      title: code,
      status,
      code,
      requestId: 'test-request-id',
      ...extra,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

/**
 * Stubs `fetch` by path. `/health` answers per `health`; `/api/v1/auth/session` answers with
 * `session` (a signed-in session by default, `null` → 401, `'down'` → network failure).
 * `routes` adds or overrides other paths, e.g. `'POST /api/v1/auth/login'`.
 */
export function mockApi({
  health = 'ok',
  session = SIGNED_IN_SESSION,
  routes = {},
}: {
  health?: 'ok' | 'down' | 'html';
  session?: object | null | 'down';
  routes?: Record<string, Route>;
} = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = routes[`${init?.method ?? 'GET'} ${path}`];
    if (route) return Promise.resolve(route(init));

    if (path === '/health') {
      if (health === 'down') return Promise.reject(new TypeError('Failed to fetch'));
      if (health === 'html')
        return Promise.resolve(new Response('<!doctype html><html></html>', { status: 200 }));
      return Promise.resolve(Response.json(HEALTHY));
    }
    if (path === '/api/v1/auth/session') {
      if (session === 'down') return Promise.reject(new TypeError('Failed to fetch'));
      if (session === null) return Promise.resolve(problem(401, 'UNAUTHENTICATED'));
      return Promise.resolve(Response.json(session));
    }
    return Promise.resolve(problem(404, 'ROUTE_NOT_FOUND'));
  });
}

/** A signed-in user, with `/health` answering per `response`. */
export function mockHealth(response: 'ok' | 'down' | 'html' = 'ok') {
  return mockApi({ health: response });
}

/**
 * Renders the real route tree inside the real providers, at the given URL. Queries don't
 * retry unless a `retryPolicy` is given, which uses the app's real QueryClient defaults.
 */
export function renderApp(
  path = '/dashboard',
  { retryPolicy }: { retryPolicy?: RetryPolicy } = {},
) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const queryClient = retryPolicy
    ? createQueryClient(retryPolicy)
    : new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...utils, router };
}
