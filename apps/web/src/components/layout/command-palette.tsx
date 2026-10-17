import { CornerDownLeft, Monitor, Moon, Search, Sun, type LucideIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { NAV_ITEMS } from '@/app/navigation';
import { overlayStyles } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/misc';
import { useTheme, type ThemePreference } from '@/lib/theme';
import { cn } from '@/lib/utils';

type Command = {
  id: string;
  group: 'Navigate' | 'Preferences';
  label: string;
  hint?: string;
  icon: LucideIcon;
  keywords: string;
  run: () => void;
};

const THEME_COMMANDS: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: 'light', label: 'Use light theme', icon: Sun },
  { value: 'dark', label: 'Use dark theme', icon: Moon },
  { value: 'system', label: 'Match system theme', icon: Monitor },
];

/**
 * Keyboard-first command menu (⌘K / Ctrl+K). Implements the ARIA combobox + listbox
 * pattern: focus stays in the input, arrow keys move the active option, Enter runs it.
 * Every command performs a real action; record search arrives with the ticket inbox.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={overlayStyles} />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            'fixed top-[12vh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden',
            'rounded-xl border border-border bg-surface-overlay shadow-lg',
            'focus:outline-none data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in',
          )}
        >
          <DialogPrimitive.Title className="sr-only">Command menu</DialogPrimitive.Title>
          {/* Remounted on every open so the query and selection always start fresh. */}
          {open && <PaletteBody onClose={() => onOpenChange(false)} />}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { setPreference, preference } = useTheme();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();

  const commands = useMemo<Command[]>(
    () => [
      ...NAV_ITEMS.map((item) => ({
        id: `nav:${item.to}`,
        group: 'Navigate' as const,
        label: item.label,
        ...(item.status === 'planned' && { hint: item.phase ?? 'Planned' }),
        icon: item.icon,
        keywords: `${item.label} ${item.summary} go open page`,
        run: () => void navigate(item.to),
      })),
      ...THEME_COMMANDS.filter((t) => t.value !== preference).map((t) => ({
        id: `theme:${t.value}`,
        group: 'Preferences' as const,
        label: t.label,
        icon: t.icon,
        keywords: `${t.label} theme appearance color mode ${t.value}`,
        run: () => setPreference(t.value),
      })),
    ],
    [navigate, preference, setPreference],
  );

  const results = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return commands;
    // Rank: label prefix > label contains > description/keyword match. Stable within a rank.
    const rank = (c: Command): number => {
      const label = c.label.toLowerCase();
      if (terms.every((t) => label.split(/\s+/).some((word) => word.startsWith(t)))) return 0;
      if (terms.every((t) => label.includes(t))) return 1;
      return terms.every((t) => `${label} ${c.keywords.toLowerCase()}`.includes(t)) ? 2 : -1;
    };
    return commands
      .map((command) => ({ command, rank: rank(command) }))
      .filter((r) => r.rank >= 0)
      .sort((a, b) => a.rank - b.rank)
      .map((r) => r.command);
  }, [commands, query]);

  const active = results[Math.min(activeIndex, results.length - 1)];
  const optionId = (command: Command) => `${listId}-${command.id}`;

  function runCommand(command: Command) {
    onClose();
    command.run();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => (i - 1 + results.length) % results.length);
    } else if (event.key === 'Enter' && active) {
      event.preventDefault();
      runCommand(active);
    }
  }

  const groups = (['Navigate', 'Preferences'] as const)
    .map((group) => ({ group, items: results.filter((c) => c.group === group) }))
    .filter((g) => g.items.length > 0);

  return (
    <>
      <div className="flex items-center gap-3 border-b border-border px-4">
        <Search className="size-4 shrink-0 text-subtle-foreground" aria-hidden="true" />
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={active ? optionId(active) : undefined}
          aria-autocomplete="list"
          aria-label="Search commands"
          placeholder="Jump to a page or run a command…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
          className="h-12 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-subtle-foreground"
        />
        <Kbd>Esc</Kbd>
      </div>

      <div
        id={listId}
        role="listbox"
        aria-label="Commands"
        className="max-h-[min(22rem,55vh)] overflow-y-auto p-2"
      >
        {groups.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <p className="text-sm font-medium">No commands match “{query}”</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Searching tickets and customers arrives with the ticket inbox in Phase 4.
            </p>
          </div>
        ) : (
          groups.map(({ group, items }) => (
            <div key={group} role="group" aria-label={group} className="mb-1 last:mb-0">
              <div
                className="px-2 pt-1.5 pb-1 text-2xs font-semibold tracking-wider text-subtle-foreground uppercase"
                aria-hidden="true"
              >
                {group}
              </div>
              {items.map((command) => {
                const isActive = command === active;
                const Icon = command.icon;
                return (
                  // Combobox pattern: keyboard input is handled on the search field (which keeps
                  // focus and points at this option via aria-activedescendant); click is for pointers.
                  // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                  <div
                    key={command.id}
                    id={optionId(command)}
                    role="option"
                    aria-selected={isActive}
                    tabIndex={-1}
                    onMouseMove={() => setActiveIndex(results.indexOf(command))}
                    onClick={() => runCommand(command)}
                    className={cn(
                      'flex h-9 cursor-default items-center gap-3 rounded-md px-2 text-sm',
                      isActive ? 'bg-surface-hover text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    <Icon
                      className={cn(
                        'size-4 shrink-0',
                        isActive ? 'text-accent-subtle-foreground' : 'text-subtle-foreground',
                      )}
                      aria-hidden="true"
                    />
                    <span className="flex-1 truncate">{command.label}</span>
                    {command.hint && (
                      <span className="text-xs text-subtle-foreground">{command.hint}</span>
                    )}
                    {isActive && (
                      <CornerDownLeft
                        className="size-3.5 text-subtle-foreground"
                        aria-hidden="true"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      <div className="flex items-center gap-4 border-t border-border bg-surface-sunken/60 px-4 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> to move
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>↵</Kbd> to select
        </span>
      </div>
    </>
  );
}
