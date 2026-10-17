# Deployment

## Frontend preview on Vercel

`apps/web` is a static Vite single-page app, so it can be deployed today as a **frontend-only
design preview**. What a visitor sees:

| Works                                                                     | Not available yet                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| App shell, navigation, themes, command palette, responsive layouts        | Sign-in and any real data. Authentication arrives in Phase 3. |
| `/design-system` component reference                                      | Tickets, customers, SLAs and analytics                        |
| `/dashboard` built from **sample data**, labelled in a badge and alert    |                                                               |
| Deep links and reloads on any route (for example `/tickets`, `/settings`) |                                                               |

No API is deployed. The sidebar status indicator makes a real request to `/health`, which
returns 404 on a frontend-only deployment, so it honestly shows **"API unreachable"** with
the detail _"No PulseDesk API responded at /health on this deployment"_. The production
bundle contains no API host and no `localhost` URL: the app always calls its own origin.

### Vercel project settings

Import `faiza-ijaz0/pulse-desk` in the Vercel dashboard (**Add New → Project**) and set:

| Setting                                                    | Value                                                           |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| Framework Preset                                           | Vite                                                            |
| Root Directory                                             | `apps/web`                                                      |
| Include files outside the root directory in the Build Step | **Enabled** (the default)                                       |
| Build Command / Output Directory / Install Command         | Leave **un-overridden**; `vercel.json` sets them                |
| Node.js Version                                            | 24.x (also picked up from `engines` in `apps/web/package.json`) |
| Production Branch                                          | `main`                                                          |
| Environment Variables                                      | None required                                                   |

`apps/web/vercel.json` holds the build settings in the repository:

- **Install:** `npx --yes pnpm@11.21.0 install --frozen-lockfile`. Running it from `apps/web` lets
  pnpm walk up to the workspace root, so `packages/shared` and the root lockfile are used.
  The version is pinned to match `packageManager` in the root `package.json`; update both
  together. The root directory must stay inside the build ("include files outside the root
  directory"), or `@pulsedesk/shared` cannot be resolved.
- **Build:** `pnpm run build` (`vite build`) → **output** `dist/`. The build refuses
  `NODE_ENV` set in an env file, so it can never ship React's development bundle.
- **SPA fallback:** every path that isn't a static file is rewritten to `/index.html`,
  **except** `/health`, `/api` and `/api/*`. Those return a real 404 instead of an HTML page
  with status 200, and they are where the API will be attached (below).
- **Headers:** long-lived immutable caching for hashed `/assets/*`; `nosniff`, `DENY` framing,
  a strict referrer policy, and a permissions policy on every response.

### Environment variables

The frontend currently reads **no** environment variables. Vite inlines every `VITE_*`
variable into the public JavaScript bundle, so they must never hold secrets, tokens or
credentials. `API_PROXY_TARGET` is read only by the local Vite dev/preview server and does
nothing on Vercel.

### Connecting an API later

The architecture keeps the browser on a single origin so session cookies stay first-party
(see [auth and sessions](architecture/auth-and-sessions.md)). When the API is deployed, put
proxy rewrites **before** the SPA fallback in `apps/web/vercel.json`, using its real host:

```json
{ "source": "/api/:path*", "destination": "https://<api-host>/api/:path*" },
{ "source": "/health", "destination": "https://<api-host>/health" }
```

Then add the Vercel production domain to the API's `WEB_ORIGIN` (https only in production).
No API host is configured until one actually exists.

### Verifying a deployment

1. Open `/tickets` directly and reload it: the planned Tickets page renders, not a 404.
2. `/health` returns Vercel's 404 page until an API is attached.
3. The dashboard shows the "Sample data" badge and the design-preview alert.

### What has been verified locally

A fresh copy of the repository (no `node_modules`, no `.env`) was installed and built from
`apps/web` with exactly the `vercel.json` commands. The resulting `dist/` was served by a local
server that follows Vercel's order (static files first, then `vercel.json` rewrites with
Vercel's `path-to-regexp` matcher, otherwise 404). Deep links, hard reloads, 404s for
`/health` and `/api/*`, and the "API unreachable" state were checked in Chromium. That is a
simulation. A real Vercel deployment still has to be created from the dashboard.
