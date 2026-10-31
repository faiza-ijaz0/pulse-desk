import { motion } from 'framer-motion';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { NavLink } from 'react-router';
import { NAV_GROUPS, type NavItem } from '@/app/navigation';
import { Kbd } from '@/components/ui/misc';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ApiStatus } from './api-status';
import { BrandMark, BrandWordmark } from './brand';
import { WorkspaceSwitcher } from './workspace-switcher';

function NavEntry({
  item,
  collapsed,
  indicatorId,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  indicatorId: string;
  onNavigate: (() => void) | undefined;
}) {
  const Icon = item.icon;
  const tooltip =
    item.status === 'planned'
      ? `${item.label} — coming in ${item.phase ?? 'a later phase'}`
      : item.label;

  return (
    <li>
      <Tooltip content={tooltip} side="right" disabled={!collapsed}>
        <NavLink
          to={item.to}
          onClick={onNavigate}
          aria-label={collapsed ? item.label : undefined}
          // A plain string, not NavLink's className callback: the Tooltip trigger (Radix Slot)
          // merges className by concatenation and would stringify a function. Active styles
          // key off the aria-current="page" that NavLink sets.
          className={cn(
            'group relative flex items-center gap-2.5 rounded-lg text-sm font-medium text-muted-foreground transition-colors',
            'hover:text-foreground not-aria-[current=page]:hover:bg-surface-hover aria-[current=page]:text-foreground',
            collapsed ? 'size-9 justify-center' : 'h-9 px-2.5',
          )}
        >
          {({ isActive }) => (
            <>
              {isActive && (
                // The active pill glides between items; a short gradient edge marks it.
                <motion.span
                  layoutId={indicatorId}
                  className="absolute inset-0 rounded-lg bg-accent/20 ring-1 ring-accent/35 ring-inset"
                  transition={{ type: 'spring', stiffness: 520, damping: 42 }}
                >
                  <span
                    aria-hidden="true"
                    className="absolute top-1.5 bottom-1.5 left-0 w-0.75 rounded-full bg-brand-gradient"
                  />
                </motion.span>
              )}
              <Icon
                className={cn(
                  'relative size-4 shrink-0 transition-colors',
                  isActive
                    ? 'text-accent-subtle-foreground'
                    : 'text-subtle-foreground group-hover:text-muted-foreground',
                )}
                aria-hidden="true"
              />
              {!collapsed && (
                <>
                  <span className="relative flex-1 truncate">{item.label}</span>
                  {item.status === 'planned' && (
                    <span className="relative rounded-full border border-border-strong px-1.5 text-2xs font-medium text-subtle-foreground">
                      Soon
                    </span>
                  )}
                  {item.status === 'preview' && (
                    <span className="relative rounded-full border border-border-strong px-1.5 text-2xs font-medium text-subtle-foreground">
                      Preview
                    </span>
                  )}
                </>
              )}
            </>
          )}
        </NavLink>
      </Tooltip>
    </li>
  );
}

export function SidebarNav({
  collapsed = false,
  indicatorId,
  onNavigate,
}: {
  collapsed?: boolean;
  indicatorId: string;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Main" className="relative flex-1 overflow-y-auto px-3 py-2">
      {NAV_GROUPS.map((group) => (
        <div key={group.label} className="mb-4 last:mb-0">
          {collapsed ? (
            <div className="mx-auto mb-2 h-px w-5 bg-border" aria-hidden="true" />
          ) : (
            <h2 className="mb-1 px-2.5 text-2xs font-semibold tracking-wider text-subtle-foreground uppercase">
              {group.label}
            </h2>
          )}
          <ul
            className={cn('grid gap-0.5', collapsed && 'justify-center')}
            aria-label={collapsed ? group.label : undefined}
          >
            {group.items.map((item) => (
              <NavEntry
                key={item.to}
                item={item}
                collapsed={collapsed}
                indicatorId={indicatorId}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Persistent sidebar for tablet (icon rail) and desktop (expanded or user-collapsed). */
export function Sidebar({
  collapsed,
  canCollapse,
  onToggle,
}: {
  collapsed: boolean;
  /** False on tablet widths, where the rail is the only layout that fits. */
  canCollapse: boolean;
  onToggle: () => void;
}) {
  return (
    <aside
      id="app-sidebar"
      aria-label="Sidebar"
      className={cn(
        // `midnight` re-themes everything inside to the dark palette, in both app themes.
        'midnight sticky top-0 hidden h-dvh shrink-0 flex-col overflow-hidden border-r border-white/8 bg-sidebar text-foreground md:flex',
        'transition-[width] duration-200 ease-out-quint',
        collapsed ? 'w-16' : 'w-62',
      )}
    >
      {/* A faint violet bloom behind the brand (decorative). */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-24 -left-16 size-64 rounded-full bg-accent/25 blur-3xl"
      />
      <div
        className={cn(
          'relative flex h-16 items-center gap-2.5',
          collapsed ? 'justify-center' : 'px-5',
        )}
      >
        <BrandMark />
        {!collapsed && <BrandWordmark />}
      </div>
      <div className={cn('relative pb-3', collapsed ? 'flex justify-center' : 'px-3')}>
        <WorkspaceSwitcher collapsed={collapsed} />
      </div>
      <SidebarNav collapsed={collapsed} indicatorId="nav-active-desktop" />
      <div
        className={cn(
          'relative flex items-center gap-1 border-t border-border py-2',
          collapsed ? 'flex-col px-2' : 'justify-between px-3',
        )}
      >
        <ApiStatus collapsed={collapsed} />
        {canCollapse && (
          <Tooltip
            content={
              <span className="flex items-center gap-2">
                {collapsed ? 'Expand sidebar' : 'Collapse sidebar'}{' '}
                <Kbd className="border-transparent bg-background/15 text-background shadow-none">
                  [
                </Kbd>
              </span>
            }
            side="right"
          >
            <button
              type="button"
              onClick={onToggle}
              aria-controls="app-sidebar"
              aria-expanded={!collapsed}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="flex size-8 items-center justify-center rounded-md text-subtle-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              {collapsed ? (
                <PanelLeftOpen className="size-4" aria-hidden="true" />
              ) : (
                <PanelLeftClose className="size-4" aria-hidden="true" />
              )}
            </button>
          </Tooltip>
        )}
      </div>
    </aside>
  );
}
