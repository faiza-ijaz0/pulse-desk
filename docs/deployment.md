# Deployment

## Frontend preview on Vercel

`apps/web` is a static Vite single-page app. Since Phase 3 every app page requires a signed-in
user, and signing in needs the API, so **a frontend-only deployment shows the sign-in and
sign-up pages and nothing else**:

| On a frontend-only deployment                                                                  | Needs the API                                       |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `/login` and `/signup`, with a warning: _"This deployment has no PulseDesk API connected yet"_ | Signing up or in, and every page behind sign-in     |
| Any other path redirects to `/login` (the session request gets a non-API 404)                  | The dashboard, design-system page and planned pages |

Submitting either form there fails with _"We couldn't reach PulseDesk"_; nothing pretends to
sign you in. The production bundle contains no API host and no `localhost` URL: the app always
calls its own origin.

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

### Connecting the API (not done yet)

**No production API exists yet.** Nothing in the repository points at one, and no API host has
been invented. To make sign-in work on the deployed site:

1. **Provision PostgreSQL** (15+) for production. Create a dedicated role that owns only the
   `pulsedesk` database. Never point production at a development or test database.
2. **Deploy `apps/api`** to any Node 24 host (a container or VM; it is a long-running Express
   server, not a serverless function). Build with `pnpm build`, run `node apps/api/dist/server.js`,
   and install production dependencies (`pnpm --filter @pulsedesk/api deploy --prod <dir>` produces a
   self-contained folder). It listens on `API_HOST:API_PORT` and exposes `GET /health` for
   liveness probes.
3. **Apply migrations** before each release: `pnpm db:deploy` with `DATABASE_URL` set to the
   production database. Never run `db:seed`, `migrate dev` or `migrate reset` against it (the
   seed refuses to run when `NODE_ENV=production`).
4. **Set these variables** in the host's secret store (the API refuses to start if any rule
   fails):

   | Variable                                                                        | Production value                                                                                                                                                        |
   | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `NODE_ENV`                                                                      | `production`                                                                                                                                                            |
   | `DATABASE_URL`                                                                  | The production connection string (secret)                                                                                                                               |
   | `SESSION_SECRET`                                                                | 32+ random characters (secret): `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Rotating it signs everyone out.                       |
   | `SESSION_COOKIE_NAME`                                                           | `__Host-pd_sid` (required in production)                                                                                                                                |
   | `SESSION_COOKIE_SECURE`                                                         | `true` (required in production)                                                                                                                                         |
   | `WEB_ORIGIN`                                                                    | The exact public `https://` origin(s) of the web app, e.g. the Vercel production domain. Comma-separate several. Used for the CSRF Origin check and the CORS allowlist. |
   | `TRUST_PROXY_HOPS`                                                              | The number of proxies in front of the API, counting Vercel's rewrite **and** the API host's load balancer. Wrong values break rate limiting (see below).                |
   | `API_HOST` / `API_PORT`                                                         | `0.0.0.0` and the port the host expects                                                                                                                                 |
   | `LOG_LEVEL`, `APP_VERSION`                                                      | e.g. `info` and the release or commit SHA                                                                                                                               |
   | `SESSION_IDLE_TIMEOUT_MINUTES`, `SESSION_ABSOLUTE_TIMEOUT_DAYS`, `RATE_LIMIT_*` | Optional; defaults are in `.env.example`                                                                                                                                |

5. **Proxy `/api` and `/health` through the web origin.** The browser must talk to a single
   origin so the session cookie is first-party and `SameSite=Lax` works without credentialed
   CORS. Add rewrites **before** the SPA fallback in `apps/web/vercel.json`, using the real API
   host:

   ```json
   { "source": "/api/:path*", "destination": "https://<api-host>/api/:path*" },
   { "source": "/health", "destination": "https://<api-host>/health" }
   ```

   The cookie is set by the API's response but stored for the Vercel domain, because that's
   the origin the browser requested. `__Host-` requires exactly that: HTTPS, no `Domain`,
   `Path=/`.

6. **Verify:** `GET /health/ready` on the API host returns `200 {"status":"ready"}` (it runs
   `SELECT 1`; `503` means the database is unreachable or the credentials are wrong; the cause is
   in the API log, never in the response). Then `/health` returns JSON through the Vercel domain; sign up; reload (the session
   is restored); sign out; check in devtools that `__Host-pd_sid` is `HttpOnly`, `Secure` and
   `SameSite=Lax`; and confirm that repeated wrong passwords are rate limited per client IP,
   not globally (if every visitor shares one limit, `TRUST_PROXY_HOPS` is too low; if
   `X-Forwarded-For` spoofing bypasses it, it is too high).

The web app itself needs **no** new environment variables: it reads none, and `VITE_*`
variables would be public anyway. Rate limits use an in-memory store, so run **one** API
instance until the Redis store lands (overview D12).

### Verifying a frontend-only deployment

1. Open `/tickets` directly and reload it: it redirects to `/login`, not a 404.
2. `/login` shows the "API is unreachable" warning; `/health` returns Vercel's 404 page.
3. `/signup` renders and validates the form client-side; submitting reports that PulseDesk
   can't be reached.

### What has been verified locally

(Phase 2, before authentication.) A fresh copy of the repository (no `node_modules`, no `.env`)
was installed and built from `apps/web` with exactly the `vercel.json` commands. The resulting `dist/` was served by a local
server that follows Vercel's order (static files first, then `vercel.json` rewrites with
Vercel's `path-to-regexp` matcher, otherwise 404). Deep links, hard reloads, 404s for
`/health` and `/api/*`, and the "API unreachable" state were checked in Chromium. That is a
simulation. A real Vercel deployment still has to be created from the dashboard.
