# Authentication and Session Security

> Status: **implemented in Phase 3**: registration, login, logout, session restoration,
> organization switching, tenant context and RBAC enforcement. Not yet built: "log out other
> devices", password change/reset, the expired-session cleanup job (needs BullMQ) and
> Socket.IO auth (§7). Endpoints and the decisions made while implementing are in
> [§10](#10-implementation-phase-3); invitations and member management in
> [§11](#11-invitations-and-member-management).

## 1. Approach

PulseDesk uses **opaque, server-managed sessions** stored in PostgreSQL. The browser
holds a random token in an **HttpOnly cookie**. No JWTs, and no tokens in `localStorage`.

Why: sessions can be revoked instantly (logout, password change, member removal),
JavaScript (and therefore XSS) cannot read the token, and the server keeps one
auditable record of active logins.

## 2. Credentials

| Item             | Decision                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Password hashing | **Argon2id** via `@node-rs/argon2` (prebuilt binaries, no node-gyp). Parameters follow OWASP minimums (m=19 MiB, t=2, p=1) and are revisited on hardware changes. Hashes are self-describing, so parameters can be upgraded on next login. |
| Password policy  | Minimum 12 characters, maximum 128 (bounds hashing cost). No composition rules. Reject the account's own email.                                                                                                                            |
| Email            | Normalized (trim + lower-case) before storage and lookup.                                                                                                                                                                                  |
| Enumeration      | Login failure returns one generic `INVALID_CREDENTIALS` error. When the user doesn't exist, the server still runs a dummy Argon2 verify so response timing doesn't reveal it.                                                              |

## 3. Session lifecycle

```
POST /api/v1/auth/login  { email, password }
  1. Rate-limit check (per IP and per email)
  2. Verify password (Argon2id)
  3. token = randomBytes(32) → base64url        (256 bits of entropy)
  4. INSERT Session { tokenHash: HMAC-SHA-256(SESSION_SECRET, token),
                      userId, activeOrganizationId, expiresAt = now + absolute TTL,
                      ipAddress, userAgent }
  5. Set-Cookie: <name>=<token>; HttpOnly; Secure; SameSite=Lax; Path=/
  6. 200 { user, organizations, activeOrganization }
```

**On every request**, the session middleware:

1. Reads the cookie, computes `HMAC(SESSION_SECRET, token)` and looks up `tokenHash`.
2. Rejects if missing, `revokedAt` set, `now > expiresAt`, or
   `now - lastSeenAt > idle timeout`.
3. Touches `lastSeenAt` **at most once per minute** to avoid a write on every request.
4. Loads the membership for `activeOrganizationId` and builds `TenantContext`.

| Property         | Value                         | Configured by                   |
| ---------------- | ----------------------------- | ------------------------------- |
| Idle timeout     | 12 hours (default)            | `SESSION_IDLE_TIMEOUT_MINUTES`  |
| Absolute timeout | 14 days (default)             | `SESSION_ABSOLUTE_TIMEOUT_DAYS` |
| Cookie `Max-Age` | Equal to the absolute timeout | derived                         |

Why HMAC instead of a plain hash: a database-only leak (backup, SQL injection) yields
neither usable tokens nor anything that can be checked offline without the server secret.

### Revocation events

| Event                   | Effect                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Logout                  | Current session `revokedAt = now`; cookie cleared                                                                                |
| "Log out other devices" | All of the user's other sessions revoked                                                                                         |
| Password change / reset | All sessions revoked, then a fresh session issued                                                                                |
| Member removed from org | Sessions with that `activeOrganizationId` lose access on the next request (membership check). The user's other orgs stay usable. |
| Expired sessions        | Deleted by a daily BullMQ cleanup job                                                                                            |

### Session fixation

A new token is always generated on login and on privilege-relevant changes
(password change, switching active organization). A pre-existing cookie is never upgraded.

## 4. Cookie configuration

| Attribute  | Production                                               | Local dev (`http://localhost`)     |
| ---------- | -------------------------------------------------------- | ---------------------------------- |
| Name       | `__Host-pd_sid` (forces `Secure`, `Path=/`, no `Domain`) | `pd_sid`                           |
| `HttpOnly` | ✅                                                       | ✅                                 |
| `Secure`   | ✅                                                       | ❌ (`SESSION_COOKIE_SECURE=false`) |
| `SameSite` | `Lax`                                                    | `Lax`                              |
| `Path`     | `/`                                                      | `/`                                |
| `Domain`   | not set (host-only)                                      | not set                            |

At startup, config validation **refuses to boot** with `NODE_ENV=production` if
`SESSION_COOKIE_SECURE` is false or `SESSION_SECRET` is the placeholder or shorter than 32 characters.

## 5. CSRF protection

Cookie authentication needs CSRF defense. PulseDesk layers three:

1. **`SameSite=Lax`** — browsers don't send the cookie on cross-site sub-requests (form POSTs, fetches).
2. **Origin verification** — for every non-safe method (`POST`, `PUT`, `PATCH`, `DELETE`),
   the `Origin` header (falling back to `Referer`) must be in the `WEB_ORIGIN` allowlist.
   Otherwise the response is `403 CSRF_ORIGIN_MISMATCH`.
3. **JSON-only API** — mutating endpoints require `Content-Type: application/json`.
   Plain HTML forms can't send that cross-site without a CORS preflight, which the API doesn't grant.

`GET`/`HEAD`/`OPTIONS` handlers must never change state.

## 6. Authorization (RBAC)

| Permission (examples)                   | OWNER |      ADMIN      |       AGENT       |
| --------------------------------------- | :---: | :-------------: | :---------------: |
| View / reply to tickets                 |  ✅   |       ✅        |        ✅         |
| Assign tickets to others                |  ✅   |       ✅        | ✅ (configurable) |
| Manage teams, tags, SLA policies        |  ✅   |       ✅        |        ❌         |
| Invite / remove members, change roles   |  ✅   | ✅ (not owners) |        ❌         |
| View analytics                          |  ✅   |       ✅        |  Own stats only   |
| Delete organization, transfer ownership |  ✅   |       ❌        |        ❌         |

- The role-to-permission map lives in `@pulsedesk/shared`. The web app uses it to hide
  controls, and the API uses it to enforce them.
- Route middleware `requirePermission('member:invite')` checks coarse access. Policy
  functions (`tickets.policy.ts`) check resource-level rules inside services.
- An organization must always have at least one `OWNER`. This is enforced in the service layer inside a transaction.
- Role changes and member removals are written to `AuditLog`.

**Write endpoints (as implemented, Phase 4D).** Every one requires a session, the trusted
`Origin` (CSRF), and a membership in the active organization that is re-read on each request,
so a removal or demotion applies to the very next request.

| Endpoint                                                             | Permission                                           | Roles                                 |
| -------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------- |
| `PATCH /organization`                                                | `organization:update`                                | Owner, Admin                          |
| `PUT /sla-policy`                                                    | `sla:manage`                                         | Owner, Admin                          |
| `PATCH /members/:userId`, `DELETE /members/:userId`                  | `member:change-role`, `member:remove`                | Owner, Admin (owners only for owners) |
| `POST /invitations`, `DELETE /invitations/:invitationId`             | `member:invite`                                      | Owner, Admin                          |
| `POST /tickets`, `PATCH /tickets/:number`, `POST …/messages`         | `ticket:reply` (+ `ticket:assign` for assignee/team) | All                                   |
| `PATCH /customers/:customerId`                                       | `customer:update`                                    | All                                   |
| `POST/PATCH/DELETE /teams…`, `PUT/DELETE /teams/:id/members/:userId` | `team:manage`                                        | Owner, Admin                          |
| `POST/PATCH/DELETE /tags…`                                           | `tag:manage`                                         | Owner, Admin                          |

A refused request (403) is identical whether or not the named resource exists, and an ID from
another organization gets the same 404 as one that never existed. This table is enforced by
`apps/api/test/integration/authorization.int.test.ts`, which fails if a write route is added
without being listed there.

## 7. Socket.IO authentication

- The handshake request carries the same session cookie (same origin).
  `io.use()` middleware validates it using the same code path as HTTP.
- The handshake `Origin` must be in the allowlist (Socket.IO's `cors`/`allowRequest`).
- On connect, the server joins the socket to `user:{userId}` and `org:{organizationId}`.
  Clients _request_ `ticket:{id}` rooms, and the server joins them only after a policy check.
- On logout or session revocation, the server disconnects that session's sockets
  (it tracks socket IDs per session ID in Redis).

## 8. Abuse protection

| Control                           | Setting                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------- |
| Login / password-reset rate limit | `RATE_LIMIT_AUTH_PER_15_MINUTES` per IP **and** per email (Redis store)      |
| Global API rate limit             | `RATE_LIMIT_GLOBAL_PER_MINUTE` per IP                                        |
| Body size limit                   | `express.json({ limit: '100kb' })`                                           |
| Proxy awareness                   | `trust proxy` set from `TRUST_PROXY_HOPS` so the real client IP is used      |
| Headers                           | `helmet` defaults + `Cache-Control: no-store` on authenticated API responses |

## 9. Out of scope for v1 (tracked for later)

- Email verification and password-reset emails (they need an SMTP setup; the plan is a dev mail catcher, no paid service)
- MFA (TOTP)
- SSO (OIDC/SAML)
- Customer portal logins (customers are contacts, not users, in v1)

## 10. Implementation (Phase 3)

### Endpoints

All under `/api/v1`, JSON only, errors as RFC 9457 problem documents. Mutating requests need an
allowlisted `Origin` (§5). The organization is never in a URL: it is the session's active one.

| Method & path                    | Requires                      | Purpose                                                                                                                                             |
| -------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/register`            | —                             | Creates user, organization, `OWNER` membership, audit entry and session in **one transaction**; `201` with the session body and cookie.             |
| `POST /auth/login`               | —                             | `200` session body and a new cookie. Wrong password and unknown email both give `401 INVALID_CREDENTIALS` (a dummy Argon2 verify equalizes timing). |
| `POST /auth/logout`              | —                             | Revokes the current session (if any) and clears the cookie. Always `204`; idempotent.                                                               |
| `GET /auth/session`              | session                       | Current user, their organizations and the active one. `401` when signed out.                                                                        |
| `POST /auth/active-organization` | session                       | `{ organizationId }`: checks membership (`404` if none), then **rotates** the session token, keeping the original absolute expiry.                  |
| `GET /organization`              | membership                    | The active organization.                                                                                                                            |
| `PATCH /organization`            | `organization:update`         | Rename (audited as `organization.updated`).                                                                                                         |
| `GET /sla-policy`                | membership                    | The default SLA policy's targets per priority, or `policy: null`.                                                                                   |
| `PUT /sla-policy`                | `sla:manage`                  | Replace every priority's targets; creates the default policy if missing (audited as `sla_policy.updated` / `.created`; no-ops write nothing).       |
| `GET /members`                   | `member:read`                 | Members of the active organization.                                                                                                                 |
| `PATCH /members/:userId`         | `member:change-role` + policy | Change a role (audited). Admins can't touch owners or grant ownership. `409 LAST_OWNER` if it would leave no owner.                                 |
| `DELETE /members/:userId`        | `member:remove` + policy      | Remove a member: unassigns their tickets, cascades team memberships, audited. `409 LAST_OWNER` likewise.                                            |

A `:userId` from another organization returns `404 NOT_FOUND`, identical to a non-existent ID.

### Code map (`apps/api/src`)

| Piece                                                               | Where                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Token generation, HMAC, shape check                                 | `modules/auth/session-token.ts`                                                      |
| Argon2id hashing, rehash check, dummy verify                        | `modules/auth/password.ts`                                                           |
| Cookie read / set / clear                                           | `modules/auth/session-cookie.ts`                                                     |
| Session lifecycle and tenant resolution                             | `modules/auth/auth.service.ts` (framework-agnostic; queries in `auth.repository.ts`) |
| `authenticate`, `requireAuth`, `requireTenant`, `requirePermission` | `http/middleware/authenticate.ts`                                                    |
| Auth rate limits                                                    | `http/middleware/rate-limit.ts`                                                      |
| Per-request `AuthContext` / `TenantContext`                         | `http/auth-context.ts` (a `WeakMap` keyed by request; no Express type augmentation)  |
| Composition of every `/api/v1` module                               | `api-router.ts`                                                                      |

### Decisions and deviations from the original design

| Topic                    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paths                    | `/api/v1/auth/*` (per conventions.md), not `/api/auth/*`. The session endpoint is `GET /api/v1/auth/session`.                                                                                                                                                                                                                                                                                                                                                                                        |
| Duplicate registration   | `409 EMAIL_TAKEN`. Without email verification (out of scope, §9), sign-up can't hide whether an email is registered without breaking the flow, so probing through sign-up is bounded by the per-IP registration rate limit instead. Two simultaneous sign-ups are settled by the unique index; the loser also gets `409`.                                                                                                                                                                            |
| Removed from active org  | The session stays valid. Tenant-scoped routes return `403 NO_ACTIVE_ORGANIZATION` and `GET /auth/session` reports `activeOrganization: null`, so the user can pick another organization. Nothing is written on these `GET`s, and the server never silently falls back to another organization mid-request.                                                                                                                                                                                           |
| Initial active org       | On login, the user's oldest membership.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Login with an old cookie | The old session is revoked before the new one is issued (session fixation).                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Invalid cookie           | The request continues unauthenticated and the response clears the cookie.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Owner invariant          | Role changes and removals run in a transaction holding `SELECT … FOR UPDATE` on the organization row, so concurrent demotions can't leave zero owners.                                                                                                                                                                                                                                                                                                                                               |
| Rate limits              | Login: failed attempts per IP **and** per email (successes don't count). Registration: every attempt per IP. In-memory store (overview D12) until Redis arrives, so limits are per instance.                                                                                                                                                                                                                                                                                                         |
| Production config        | The API refuses to start in production unless `SESSION_COOKIE_SECURE=true`, the cookie name starts with `__Host-`, `SESSION_SECRET` isn't the placeholder, and every `WEB_ORIGIN` is `https://`. The placeholder secret is accepted only in development.                                                                                                                                                                                                                                             |
| Database outages         | Prisma connection/credential errors (`P1000`, `P1001`, `P1002`, `P1003`, `P1008`, `P1017`, `P2024`) become `503 SERVICE_UNAVAILABLE` with `Retry-After: 30`, logged as `Database unavailable` with the `errorCode` and request ID. Other unexpected errors stay a generic `500` whose log line also carries an `errorCode`. The web app shows "temporarily unavailable" for 503, "couldn't reach PulseDesk" when no API answers, field errors for 400s, and a reference ID only for unexpected 500s. |
| Schema                   | No migration was needed: the Phase 2 `Session`, `Membership` and `AuditLog` models already had every column.                                                                                                                                                                                                                                                                                                                                                                                         |

## 11. Invitations and member management

Owners and admins invite people into the session's active organization; the invitee joins with
a single-use link. There is no email delivery yet (see "Delivering links" below).

### Endpoints

| Method & path                       | Requires                         | Purpose                                                                                                                                                                                   |
| ----------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /invitations`                  | `member:invite`                  | Open invitations (neither accepted nor revoked) of the active organization, `pending` or `expired`.                                                                                       |
| `POST /invitations`                 | `member:invite`                  | `{ email, role }` (`ADMIN` or `AGENT`) → `201 { invitation, token }`, `Cache-Control: no-store`. Revokes an open invitation to the same email. `409 ALREADY_MEMBER` for a current member. |
| `DELETE /invitations/:invitationId` | `member:invite`                  | Revoke: `204`; again → `204`, nothing written. Accepted → `409 CONFLICT`. Another organization's ID → `404`, like an unknown one.                                                         |
| `POST /invitations/preview`         | — (rate limited)                 | `{ token }` → organization name, invited email, role, inviter's name, expiry. A token that can't be used → `410 INVITATION_INVALID`.                                                      |
| `POST /invitations/accept`          | session (rate limited)           | `{ token }`: the signed-in user joins, then the session is **rotated** into the organization. Only the invited email may accept.                                                          |
| `POST /invitations/register`        | — (rate limited, as sign-up too) | `{ token, name, password }`: a new account **with the invitation's email** (it can't be chosen), its membership and its first session.                                                    |

### Security decisions

| Topic                  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token                  | 32 random bytes (`crypto.randomBytes`), base64url. Only `HMAC-SHA-256(SESSION_SECRET, "invitation:" + token)` is stored (`Invitation.tokenHash`, unique); the prefix keeps it distinct from session hashes. The raw token is in the creation response only, and in no log, audit entry or URL path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Link                   | `/invite#<token>`: a URL fragment never reaches a server, a proxy log or a `Referer` header. The page reads it, removes it from the address bar at once, and sends it only in JSON bodies. `*.token` and `*.tokenHash` are redacted from logs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Roles                  | `ADMIN` or `AGENT` only; ownership is granted later by an owner (`Invitation_role_check`). Inviting into a role also passes `canManageRole`, the role-change rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Who may accept         | Only an account whose email equals the invitation's (both normalized). Another account gets `403 INVITATION_EMAIL_MISMATCH`, nothing changes, and the attempt is audited (`invitation.accept_refused`). New accounts take the invitation's email. **This is not proof that the person owns that email**: accounts are not email-verified (§9), so until links are delivered by email the link is a **bearer credential**. Anyone holding it can create the account for the invited email if none exists yet; the email check only stops a _different, existing_ account from using a forwarded link. Inviters must share links only through a channel they trust and revoke any that leak. And because sign-up is open, anyone can register an email before its invitee does, which then blocks the invitee from joining (a sign-up limitation that predates invitations). |
| Expiry, replay, revoke | 7 days (`INVITATION_TTL_DAYS`); at exactly `expiresAt` a link stops working. Accepting sets `acceptedAt`/`acceptedByUserId`, revoking sets `revokedAt`; either ends it for good (`Invitation_single_outcome_check`). Every use re-checks all three under a row lock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Races                  | Accepting and invitation sign-up lock the invitation row `FOR UPDATE` before using it (after a `FOR KEY SHARE` lock on its organization: data-model.md, "Concurrency"), so two uses of one link take turns and the second finds it used. The membership's `(organizationId, userId)` key backs up "no duplicate membership". Revoking is a conditional update, so it and an acceptance can't both win. Creating is serialized per organization by an advisory lock, with `Invitation_one_open_per_email_key` as the backstop; it revokes the previous invitation to the email conditionally and checks membership only afterwards, so re-inviting while that invitation is being accepted answers `409 ALREADY_MEMBER`.                                                                                                                                                    |
| Account privacy        | Inviting an email that has an account elsewhere answers exactly like any other email. The link's holder learns the invitation's own details and, as on normal sign-up, that an account exists for _that_ email when they try to create one (`409 EMAIL_TAKEN`: sign in instead).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Tenant scope           | Management reads and writes always carry the session's organization. Finding an invitation by token is the one lookup keyed by something else (a 256-bit secret), in raw SQL; every write after it carries that invitation's own `organizationId`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Audit                  | `invitation.created` (email, role, expiry, replaced invitation), `invitation.revoked` (with `reason: inviter_removed / inviter_demoted` when revoked by a member change), `invitation.accepted` (with `newAccount`), `invitation.accept_refused`. No-ops (revoking twice, a role change to the same role) write nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Rate limits            | Preview, accept and invitation sign-up count **failed** requests per IP (`invitation-ip`), so an invitee is never locked out; invitation sign-up also shares the sign-up limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Member management

The existing `GET`/`PATCH`/`DELETE /members` endpoints are unchanged: admins manage admins and
agents, only owners manage owners or grant ownership, nobody can raise their own role, and the
last owner can't be demoted or removed (checked under a lock). Changing or leaving one's own
membership is allowed within those rules (the UI asks for confirmation). Removal takes effect on
the member's very next request, because every tenant request re-reads the membership. Their
sessions are **not** revoked: a session belongs to the user, who may belong to other
organizations, and it keeps working there (the active organization reports
`NO_ACTIVE_ORGANIZATION` until they switch).

An inviter has seen each of their links, so their **open invitations are revoked** when they are
removed or demoted to a role without `member:invite` (Admin → Agent; Owner → Admin keeps
them), in the same transaction as the change, each audited as `invitation.revoked` with
`reason: inviter_removed` or `inviter_demoted`. Otherwise a removed admin could rejoin, for
example as an admin through an invitation they had sent to another address of theirs. An
invitation accepted before the change stays accepted: it was valid when it was used.

### Delivering links

There is no email service, which is why the link is a bearer credential (see "Who may accept"). The inviter sees the link **once**, in the invite dialog, to copy and
send themselves; only its hash is stored, so it can't be shown again (inviting the same email
again issues a new link and revokes the old). Real delivery needs: an SMTP or provider account
(not set up; no paid service is used), a sender domain with SPF/DKIM, a mail adapter called after
the creation transaction commits (the token never goes to a queue or log), and a decision on
whether the inviter should still see the link once email exists.
