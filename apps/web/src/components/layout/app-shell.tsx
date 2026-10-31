import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import { usePersistentFlag } from '@/lib/use-local-storage';
import { DESKTOP_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { CommandPalette } from './command-palette';
import { MobileNav } from './mobile-nav';
import { ShortcutsDialog } from './shortcuts-dialog';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

/**
 * Layout by width:
 *  - < 768px   top bar + navigation drawer (no persistent sidebar)
 *  - 768–1023  icon rail with tooltips
 *  - ≥ 1024    full sidebar, collapsible to the rail (persisted)
 */
export function AppShell() {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [userCollapsed, setUserCollapsed] = usePersistentFlag('pulsedesk-sidebar-collapsed', false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const { pathname } = useLocation();

  const collapsed = !isDesktop || userCollapsed;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      if (event.key === '[' && isDesktop) {
        setUserCollapsed(!userCollapsed);
      } else if (event.key === '?') {
        setShortcutsOpen(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isDesktop, userCollapsed, setUserCollapsed]);

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-surface px-3 py-2 text-sm font-medium shadow-md focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <Sidebar
        collapsed={collapsed}
        canCollapse={isDesktop}
        onToggle={() => setUserCollapsed(!userCollapsed)}
      />
      <MobileNav open={mobileNavOpen} onOpenChange={setMobileNavOpen} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          onOpenMobileNav={() => setMobileNavOpen(true)}
          onOpenPalette={() => setPaletteOpen(true)}
          onShowShortcuts={() => setShortcutsOpen(true)}
        />
        <main id="main" tabIndex={-1} className="relative flex-1 focus:outline-none">
          {/* A soft violet/turquoise aurora behind the top of every page (decorative). */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-[26rem] bg-aurora"
          />
          <motion.div
            key={pathname}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="relative mx-auto w-full max-w-[1400px] px-4 py-6 md:px-6 lg:px-8 lg:py-8"
          >
            <Outlet />
          </motion.div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}
