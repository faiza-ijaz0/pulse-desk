import { Keyboard, LogOut, Menu, Monitor, Moon, Search, Sun } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import { findNavItem } from '@/app/navigation';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, Kbd } from '@/components/ui/misc';
import { Tooltip } from '@/components/ui/tooltip';
import { ROLE_LABELS } from '@/features/auth/role-label';
import { useActiveSession, useLogout } from '@/features/auth/session';
import { useTheme, type ThemePreference } from '@/lib/theme';
import { BrandMark } from './brand';

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function ThemeMenu() {
  const { preference, resolved, setPreference } = useTheme();
  const CurrentIcon = resolved === 'dark' ? Moon : Sun;
  return (
    <DropdownMenu>
      <Tooltip content="Theme">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Theme: ${preference}. Change theme`}>
            <CurrentIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(v) => setPreference(v as ThemePreference)}
        >
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon aria-hidden="true" />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The signed-in user's menu: who they are, where they are, and signing out. */
function ProfileMenu({ onShowShortcuts }: { onShowShortcuts: () => void }) {
  const { user, activeOrganization } = useActiveSession();
  const logout = useLogout();
  const navigate = useNavigate();

  function signOut() {
    logout.mutate(undefined, { onSettled: () => void navigate('/login', { replace: true }) });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex size-8 items-center justify-center rounded-full transition-shadow hover:ring-2 hover:ring-border-strong data-[state=open]:ring-2 data-[state=open]:ring-border-strong"
        aria-label={`Account menu for ${user.name}`}
      >
        <Avatar name={user.name} className="ring-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <div className="px-2 py-2">
          <p className="truncate text-sm font-medium">{user.name}</p>
          <p className="truncate text-xs text-muted-foreground">{user.email}</p>
          <p className="mt-1.5 truncate text-xs text-muted-foreground">
            {ROLE_LABELS[activeOrganization.role]} · {activeOrganization.name}
          </p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onShowShortcuts}>
          <Keyboard aria-hidden="true" />
          Keyboard shortcuts
          <DropdownMenuShortcut>?</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut} disabled={logout.isPending}>
          <LogOut aria-hidden="true" />
          {logout.isPending ? 'Signing out…' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Topbar({
  onOpenMobileNav,
  onOpenPalette,
  onShowShortcuts,
}: {
  onOpenMobileNav: () => void;
  onOpenPalette: () => void;
  onShowShortcuts: () => void;
}) {
  const { pathname } = useLocation();
  const current = findNavItem(pathname);
  const { activeOrganization } = useActiveSession();

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/85 px-4 backdrop-blur-md supports-[backdrop-filter]:bg-background/70 md:px-6">
      <Button
        variant="ghost"
        size="icon-sm"
        className="-ml-1.5 md:hidden"
        onClick={onOpenMobileNav}
        aria-label="Open navigation"
      >
        <Menu aria-hidden="true" />
      </Button>
      <BrandMark className="size-6 md:hidden" />

      <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 text-sm sm:flex">
        <span className="truncate text-muted-foreground">{activeOrganization.name}</span>
        {current && (
          <>
            <span className="text-subtle-foreground" aria-hidden="true">
              /
            </span>
            <span className="truncate font-medium" aria-current="page">
              {current.label}
            </span>
          </>
        )}
      </nav>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={onOpenPalette}
          className="hidden h-8 w-64 items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-sm text-subtle-foreground shadow-xs transition-colors hover:border-border-strong hover:text-muted-foreground md:flex lg:w-72"
          aria-label="Open command menu"
          aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
        >
          <Search className="size-4" aria-hidden="true" />
          <span className="flex-1 text-left">Search or jump to…</span>
          <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
          <Kbd>K</Kbd>
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="md:hidden"
          onClick={onOpenPalette}
          aria-label="Open command menu"
        >
          <Search aria-hidden="true" />
        </Button>
        <ThemeMenu />
        <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <ProfileMenu onShowShortcuts={onShowShortcuts} />
      </div>
    </header>
  );
}
