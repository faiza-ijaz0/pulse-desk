import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

const ENV_DIR = '../..';

type VercelConfig = { headers: { source: string; headers: { key: string; value: string }[] }[] };

/**
 * The security headers vercel.json sets on every SPA response, so `vite preview` (and the E2E
 * suite, which runs against it) serves the app under the same Content-Security-Policy as
 * production. Not used by the dev server: Vite's HMR needs an inline React Refresh preamble
 * and a WebSocket that this policy deliberately blocks.
 */
function productionSecurityHeaders(): Record<string, string> {
  const config = JSON.parse(
    readFileSync(new URL('./vercel.json', import.meta.url), 'utf8'),
  ) as VercelConfig;
  const rule = config.headers.find((entry) => entry.source === '/(.*)');
  if (!rule) throw new Error('vercel.json has no "/(.*)" headers rule');
  return Object.fromEntries(rule.headers.map(({ key, value }) => [key, value]));
}

export default defineConfig(({ command, mode }) => {
  const fileEnv = loadEnv(mode, ENV_DIR, '');
  // Vite honours NODE_ENV from env files (loadEnv moves it to VITE_USER_NODE_ENV), so a stray
  // `NODE_ENV=development` in the shared root .env would silently turn `vite build` into a
  // development bundle. Fail loudly instead.
  const fileNodeEnv = process.env.VITE_USER_NODE_ENV;
  if (command === 'build' && fileNodeEnv && fileNodeEnv !== 'production') {
    throw new Error(
      `NODE_ENV=${fileNodeEnv} is set in an env file in the repository root, which would ` +
        'make this a development build. Remove it from .env (see .env.example).',
    );
  }

  // The browser only ever talks to one origin. Locally, Vite forwards API traffic to the
  // Express server so session cookies stay first-party (see docs/architecture/overview.md).
  // API_PROXY_TARGET is read on the Node side only; it never reaches the browser bundle.
  const env = { ...fileEnv, ...process.env };
  const apiTarget = env.API_PROXY_TARGET ?? 'http://127.0.0.1:4000';
  // If the API is configured to require the proxy secret, send it like Vercel does in
  // production (apps/web/vercel.json): set on the forwarded request, replacing any client
  // copy. Node-side only — it is never part of the browser bundle (only VITE_* vars are).
  const secret = env.PROXY_SHARED_SECRET;
  const headers = secret ? { 'x-pulsedesk-proxy-secret': secret } : undefined;
  const target = { target: apiTarget, changeOrigin: false, ...(headers && { headers }) };
  const proxy = { '/api': target, '/health': target };

  return {
    plugins: [react(), tailwindcss()],
    envDir: ENV_DIR,
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: { port: 5173, strictPort: true, proxy },
    preview: { port: 4173, strictPort: true, proxy, headers: productionSecurityHeaders() },
    build: {
      sourcemap: true,
      rolldownOptions: {
        output: {
          // Long-lived vendor chunks: framework code changes far less often than app code,
          // so splitting it keeps browser caches warm across deploys.
          codeSplitting: {
            groups: [
              {
                name: 'react',
                test: /node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/,
              },
              {
                name: 'ui',
                test: /node_modules[\\/](radix-ui|@radix-ui|@floating-ui|framer-motion|motion-dom|motion-utils)[\\/]/,
              },
              // zod-csp.ts sets Zod's `jitless` flag. Schemas read it when they're created
              // at module scope in other chunks, so it must run inside Zod's own chunk:
              // there it executes right after Zod and before any chunk that depends on it.
              {
                name: 'data',
                test: /node_modules[\\/](zod|@tanstack)[\\/]|[\\/]src[\\/]lib[\\/]zod-csp\.ts$/,
              },
            ],
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      css: false,
      // Form tests type real keystrokes through user-event in jsdom, which can exceed the
      // 5 s default when `pnpm check` runs every workspace's tests in parallel.
      testTimeout: 15_000,
    },
  };
});
