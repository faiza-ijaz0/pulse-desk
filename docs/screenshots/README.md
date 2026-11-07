# Screenshots

This folder has **no screenshots yet**. They will be captured from the real application once
the local UI is finalized. Placeholder or generated images must not be added here: every
image should be a genuine capture of PulseDesk running locally.

## Screens to capture

| File (suggested)          | Screen                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `dashboard-light.png`     | Live dashboard with seed data: metric cards, SLA health, tickets by status, workload |
| `tickets-inbox-light.png` | Ticket inbox with filters and SLA badges                                             |
| `ticket-detail-light.png` | Ticket detail: conversation, internal note, properties and activity timeline         |
| `customers-light.png`     | Customer list and a customer's ticket history                                        |
| `sla-policies-light.png`  | SLA policies page with first-response and resolution targets per priority            |
| `team-light.png`          | Agents & teams: members, roles and invitations                                       |
| `settings-light.png`      | Settings: organization profile, auto-close and tags                                  |
| `*-dark.png`              | The same key screens (at least inbox and ticket detail) in the dark theme            |
| `mobile-*.png` (optional) | Inbox and ticket detail at a phone-sized viewport                                    |

## How to capture

1. Start the app locally with the seed data (`pnpm db:seed`, then `pnpm dev`) and sign in as a
   seeded user, e.g. `maya@brightwave.test` (see [docs/development.md](../development.md)).
2. Use a desktop viewport of about 1440 × 900 and the browser's built-in screenshot tool.
3. Use only the fictional seed data; never capture real customer data, cookies or
   invitation links.
4. Save PNGs here with the names above and reference them from the root `README.md`.
