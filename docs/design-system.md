# Design System

PulseDesk is a tool support agents keep open all day. The visual language is **calm,
dense and premium**: a midnight-navy frame (the sidebar and auth panel stay midnight in both
themes), porcelain or blue-black work surfaces, an electric-violet accent with selective
fuchsia and turquoise, crisp hairline borders, soft layered shadows, and motion only where it
explains a change. Gradients are decorative (brand mark, page aurora, hero, active
navigation edge, chart bars); text never depends on one.

The living reference is the **Design system** page in the app (`/design-system`), which
renders every token, component and state below in the current theme.

## Tokens

All tokens are CSS variables in [`apps/web/src/styles/globals.css`](../apps/web/src/styles/globals.css),
mapped onto Tailwind utilities through `@theme`. Components use semantic tokens only
(`bg-surface`, `text-muted-foreground`, `border-border`) — never raw colors — so the dark
theme is a set of different values, not different class names.

| Group      | Tokens                                                                                             | Notes                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Surfaces   | `background`, `surface`, `surface-sunken`, `surface-hover`, `surface-overlay`, `sidebar`           | Light: porcelain with a faint violet cast (hue 292). Dark: blue-black midnight (hue 272). `sidebar` is the midnight frame in both themes.     |
| Text       | `foreground`, `muted-foreground`, `subtle-foreground`                                              | Midnight-navy text in light mode. `muted` for secondary text; `subtle` for placeholders, icons and tertiary metadata. All meet AA everywhere. |
| Lines      | `border`, `border-strong`, `input`                                                                 | 1px hairlines; `border-strong` for controls and emphasis.                                                                                     |
| Accent     | `accent`, `accent-hover`, `accent-foreground`, `accent-subtle`, `accent-subtle-foreground`, `ring` | Electric violet. Primary actions, active navigation, focus rings, selection.                                                                  |
| Supporting | `magenta` (+ `-subtle`, `-foreground`), `coral`                                                    | Fuchsia for gradients, avatars and one dashboard metric; coral for the High priority edge. Used sparingly.                                    |
| Status     | `success`, `warning`, `danger`, `info`, each with `-subtle` and `-foreground`                      | Reserved for state; `info` is turquoise. Always paired with text and/or an icon, never color alone.                                           |
| Data viz   | `chart-1` … `chart-4`                                                                              | Violet, turquoise, fuchsia, amber; ≥ 3:1 against the surface in both themes.                                                                  |
| Gradients  | `bg-brand-gradient`, `bg-brand-gradient-soft`, `bg-aurora`                                         | Utilities over `--gradient-*` tokens. Decorative only; text sits on the soft gradient only where it was checked (≥ 6.6:1).                    |
| Elevation  | `shadow-xs` … `shadow-lg`, `--highlight`, `--glow`                                                 | Tinted with midnight, not pure black. Cards use `highlight` + `sm`; overlays `lg`; primary buttons glow violet on hover.                      |
| Radius     | `radius-xs` (4px) … `radius-2xl` (20px)                                                            | Controls and buttons `lg` (12px) or `md` (8px); cards `xl` (16px); hero and dialogs `2xl`. Badges are pills.                                  |

**Midnight scope.** `.midnight` applies the dark palette to one region (the sidebar, the mobile
drawer and the auth brand panel) whatever the app theme, so every component inside it stays
legible without different class names. Don't use `dark:` variants inside it: they follow the
app theme, not the scope.

Every text/surface pair is checked numerically in both themes and inside the midnight scope
(WCAG ratio from the OKLCH values): text ≥ 4.5:1, focus ring and chart colors ≥ 3:1.
| Typography | Geist (UI), Geist Mono (IDs, shortcuts); `text-2xs` 11px … `text-3xl` 28px | A dense product scale: 13px for tables and controls, 14px body. Headings use −0.015em tracking. Tabular numerals in columns only. |
| Spacing | Tailwind's 4px base unit | Page gutters 16 / 24 / 32px by breakpoint; card padding 20px; control height 32–40px. |
| Motion | `ease-out-quint`; 120–260ms | Overlay, pop and drawer keyframes are defined as tokens. |

Fonts are self-hosted from npm (`@fontsource-variable/*`), so no third-party font CDN is
contacted.

## Components

Built in [`apps/web/src/components/ui`](../apps/web/src/components/ui) in the shadcn/ui
style: source lives in the repo, accessible behavior comes from Radix primitives
(`radix-ui`), variants from `class-variance-authority`.

| Component                                       | Behavior worth knowing                                                                                                                                                                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                                        | Variants `primary`, `secondary`, `ghost`, `danger`, `link`; sizes `sm`/`md`/`lg`/`icon`/`icon-sm`. `loading` keeps the label (no layout shift), shows a spinner, sets `aria-busy` and blocks clicks. Defaults to `type="button"`. `asChild` styles links. |
| `Input`, `Textarea`                             | Invalid styling is driven by `aria-invalid`, so visuals and semantics can't drift apart.                                                                                                                                                                  |
| `Field`                                         | Label + control + description + error/success message. Wires `id`, `aria-describedby`, `aria-invalid`, `required` and `disabled` into the control via a render prop.                                                                                      |
| `Badge`                                         | Six tones; optional status dot. Ticket status/priority badges build on it.                                                                                                                                                                                |
| `Card`                                          | `section` with header, title (`h2`), description, content, footer.                                                                                                                                                                                        |
| `Dialog`, `Sheet`                               | Radix dialog: focus trap, Escape, focus restored to the trigger. `Sheet` is the left drawer used for mobile navigation.                                                                                                                                   |
| `DropdownMenu`                                  | Full keyboard support, radio/checkbox items, submenus, disabled items with explanations.                                                                                                                                                                  |
| `Tooltip`                                       | Shown on hover and keyboard focus; labels icon-only controls.                                                                                                                                                                                             |
| `Table`                                         | Scrolls horizontally inside its card if needed; phone layouts use stacked lists instead.                                                                                                                                                                  |
| `Skeleton`, `Spinner`, `Alert`, `Kbd`, `Avatar` | Loading placeholders, inline status (`role="status"`, or `alert` for errors), shortcut keys, deterministic initials avatars.                                                                                                                              |
| `EmptyState`, `ErrorState`, `PageHeader`        | Every data view has empty and error states; `ErrorState` retry triggers a real re-fetch.                                                                                                                                                                  |

## Layout and responsiveness

| Width      | Navigation                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| < 768px    | Top bar with menu button → full-height navigation drawer with 40px touch targets. No persistent sidebar. Tables become stacked lists. |
| 768–1023px | 64px icon rail with tooltips.                                                                                                         |
| ≥ 1024px   | 248px sidebar, collapsible to the rail (button or `[`), remembered per browser.                                                       |

The shell provides a skip link, `main`/`nav`/`aside` landmarks, a breadcrumb, a ⌘K/Ctrl+K
command menu (ARIA combobox), a theme menu (light / dark / system), an organization switcher listing the signed-in
user’s real memberships, and an account menu with sign-out. Sign-in and sign-up use a
separate two-column auth layout (form plus a product panel on wide screens).

## Motion

- Page content fades up 6px on route change (240ms); dashboard cards stagger by 40ms.
- The active navigation item's violet pill (with its gradient edge) glides between items
  (shared layout animation).
- Metric cards lift 2px on hover; list rows and the composer change their wash or border on
  hover and focus. Nothing moves on its own except loading skeletons.
- Overlays pop in from 97% scale; drawers slide.
- `MotionConfig reducedMotion="user"` plus a global `prefers-reduced-motion` rule reduce all
  of it to near-instant changes.

## Accessibility contract

WCAG 2.2 AA in both themes, enforced by axe scans in the E2E suite plus ESLint
`jsx-a11y` (strict). Every interactive element is keyboard-operable with a visible 2px focus
ring; status never relies on color alone; charts provide a table view and per-item labels.

Rules learned from the axe scans:

- **Every text token meets 4.5:1 on every surface it can sit on** — including `surface-hover`
  and `surface-sunken`, and including `subtle-foreground`, which is used for real text
  (section labels, "Soon" tags), not only placeholders.
- **Hover states keep contrast too.** Axe only checks resting states, so `accent-hover` and
  `danger-hover` are checked by hand: in dark mode they darken rather than lighten, keeping
  white labels above 4.5:1.
- **Don't fade whole groups.** A disabled `Field` styles only its control; the label and help
  text stay at full contrast because they explain why the field is locked.
- **Wide tables scroll by keyboard.** `Table` becomes a labelled, focusable region only when
  its content actually overflows, so tables that fit add no tab stop.
- **Don't pass a `className` callback through a Radix `asChild` trigger** (e.g. a `NavLink`
  inside a `Tooltip`): `Slot` concatenates class strings and stringifies the function. Use a
  string with `aria-[current=page]:` variants instead.

## Honesty rules for previews

Until a feature is real, the UI says so:

- Sample data lives in clearly named modules (e.g. `features/dashboard/sample-data.ts`) and
  is labelled in the UI with a badge and an explanatory alert.
- Planned pages explain what will exist and in which phase; they contain no inert controls.
- Controls that depend on unbuilt features are disabled and explain why.
