import { AlertDialog } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { overlayStyles } from './dialog';

/**
 * Confirmation for a destructive action (role="alertdialog"). Focus starts on Cancel, the
 * dialog stays open while the action runs, and an error is shown inside it.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  pending: boolean;
  error?: string | undefined;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={overlayStyles} />
        <AlertDialog.Content
          className={cn(
            'fixed top-[18vh] left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-md -translate-x-1/2 gap-4',
            'rounded-xl border border-border bg-surface-overlay p-6 shadow-lg',
            'focus:outline-none data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in',
          )}
        >
          <div className="grid gap-1.5">
            <AlertDialog.Title className="text-lg font-semibold">{title}</AlertDialog.Title>
            <AlertDialog.Description className="text-sm text-muted-foreground">
              {description}
            </AlertDialog.Description>
          </div>
          {error && (
            <p
              role="alert"
              className="rounded-md border border-danger/25 bg-danger-subtle px-3 py-2 text-sm text-danger-foreground"
            >
              {error}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary" disabled={pending}>
                Cancel
              </Button>
            </AlertDialog.Cancel>
            {/* Not AlertDialog.Action: that would close the dialog before the request ends. */}
            <Button variant="danger" loading={pending} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
