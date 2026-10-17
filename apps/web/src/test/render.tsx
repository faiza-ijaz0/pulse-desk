import { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { AppProviders } from '@/app/providers';
import { routes } from '@/app/router';

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

export function mockHealth(response: 'ok' | 'down' | 'html' = 'ok') {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    if (response === 'down') return Promise.reject(new TypeError('Failed to fetch'));
    if (response === 'html')
      return Promise.resolve(new Response('<!doctype html><html></html>', { status: 200 }));
    return Promise.resolve(Response.json(HEALTHY));
  });
}

/** Renders the real route tree inside the real providers, at the given URL. */
export function renderApp(path = '/dashboard') {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...utils, router };
}
