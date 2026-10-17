import { Building2, ChevronsUpDown, LogIn } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * Organizations come from the signed-in user's memberships, which arrive with
 * authentication in Phase 3. Until then the switcher shows the one preview workspace
 * and says so — it does not pretend to list real organizations.
 */
export function WorkspaceSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <DropdownMenu>
      <Tooltip content="Preview workspace" side="right" disabled={!collapsed}>
        <DropdownMenuTrigger
          className={cn(
            'group flex w-full items-center gap-2.5 rounded-md border border-transparent text-left transition-colors',
            'hover:border-border hover:bg-surface-hover data-[state=open]:border-border data-[state=open]:bg-surface-hover',
            collapsed ? 'size-9 justify-center' : 'h-11 px-2',
          )}
          aria-label="Switch workspace. Current: Preview workspace"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface-sunken text-xs font-semibold text-muted-foreground">
            PW
          </span>
          {!collapsed && (
            <>
              <span className="grid min-w-0 flex-1 leading-tight">
                <span className="truncate text-sm font-medium">Preview workspace</span>
                <span className="truncate text-xs text-muted-foreground">Sample data</span>
              </span>
              <ChevronsUpDown
                className="size-4 shrink-0 text-subtle-foreground"
                aria-hidden="true"
              />
            </>
          )}
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start" side={collapsed ? 'right' : 'bottom'} className="w-64">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        <DropdownMenuRadioGroup value="preview">
          <DropdownMenuRadioItem value="preview">
            <Building2 aria-hidden="true" />
            Preview workspace
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled className="h-auto items-start py-2">
          <LogIn className="mt-0.5" aria-hidden="true" />
          <span className="grid gap-0.5">
            <span>Your organizations</span>
            <span className="text-xs text-muted-foreground">Available after sign-in (Phase 3)</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
