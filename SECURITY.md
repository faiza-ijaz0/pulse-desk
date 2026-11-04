# Security Policy

PulseDesk handles authentication, sessions and data from several organizations in one
database, so security reports are welcome and taken seriously.

## Supported versions

PulseDesk is developed on a single branch. Only the latest commit on `main` receives fixes;
there are no maintained release lines.

## Reporting a vulnerability

**Please don't report security vulnerabilities in public GitHub issues, pull requests or
discussions.** Public details can put users at risk before a fix exists.

This repository has no dedicated security email address or private reporting endpoint
configured. Instead:

1. Contact the repository owner, [@faiza-ijaz0](https://github.com/faiza-ijaz0), through a
   **private** channel. If GitHub's "Report a vulnerability" button is available on this
   repository's **Security** tab, use it; otherwise use a private contact method listed on
   the owner's GitHub profile.
2. If you can't find a private channel, you may open a public issue that says only that you
   have a security report and asks for a private contact. **Don't include any details** of
   the vulnerability in it.

## What to include

A useful report contains:

- the affected area (for example sign-in, sessions, invitations, tenant isolation, a specific
  API route) and the commit you tested;
- a description of the issue and its impact (what an attacker could read, change or do);
- step-by-step reproduction instructions, with the minimum request(s) or code needed;
- whether it needs an account, a particular role (Owner, Admin or Agent) or membership of
  another organization;
- any logs or screenshots that help, **with secrets, session cookies, invitation links and
  personal data removed**;
- a suggested fix, if you have one.

Please test only against your own local installation. Don't access other people's data,
degrade a running service, or use social engineering.

## What to expect

- Reports are acknowledged as soon as reasonably possible. This is a personal project, so
  there is no guaranteed response time.
- You'll be told whether the report is confirmed, and kept informed while a fix is
  prepared.
- Fixes are released on `main`. Please keep the details private until a fix is available;
  coordinated disclosure afterwards is welcome, and reporters are credited if they wish.

## Security practices in this codebase

The current safeguards (Argon2id passwords, hashed server-side sessions, `__Host-` cookies,
CSRF origin checks, rate limits, tenant isolation in code and database constraints, hashed
single-use invitation tokens and log redaction) are described in
[docs/architecture/auth-and-sessions.md](docs/architecture/auth-and-sessions.md) and
[docs/architecture/data-model.md](docs/architecture/data-model.md).
