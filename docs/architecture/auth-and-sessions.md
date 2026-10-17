# Authentication and Session Security

> Status: design. Implemented so far (Phase 2): the Origin/Referer CSRF check and the
> JSON-only request body rule from §5, and the in-memory global rate limit from §8.
> Sessions, login and RBAC enforcement arrive in Phase 3.

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
POST /api/auth/login  { email, password }
  1. Rate-limit check (per IP and per email)
  2. Verify password (Argon2id)
  3. token = randomBytes(32) → base64url        (256 bits of entropy)
  4. INSERT Session { tokenHash: HMAC-SHA-256(SESSION_SECRET, token),
                      userId, activeOrganizationId, expiresAt = now + absolute TTL,
                      ipAddress, userAgent }
  5. Set-Cookie: <name>=<token>; HttpOnly; Secure; SameSite=Lax; Path=/
  6. 200 { user, memberships, activeOrganization }
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
