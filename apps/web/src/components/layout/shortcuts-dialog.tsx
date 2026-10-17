import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/misc';
import { isMac } from './topbar';

const SHORTCUTS = [
  { keys: [isMac ? '⌘' : 'Ctrl', 'K'], label: 'Open the command menu' },
  { keys: ['['], label: 'Collapse or expand the sidebar (desktop)' },
  { keys: ['?'], label: 'Show keyboard shortcuts' },
  { keys: ['Esc'], label: 'Close menus and dialogs' },
];

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts work anywhere except while typing in a field.
          </DialogDescription>
        </DialogHeader>
        <dl className="divide-y divide-border rounded-lg border border-border">
          {SHORTCUTS.map(({ keys, label }) => (
            <div
              key={label}
              className="flex items-center justify-between gap-4 px-3 py-2.5 text-sm"
            >
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="flex shrink-0 gap-1">
                {keys.map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
