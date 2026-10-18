import { Building2, ChevronsUpDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip } from '@/components/ui/tooltip';
import { describeAuthError } from '@/features/auth/form-helpers';
import { ROLE_LABELS } from '@/features/auth/role-label';
import { useActiveSession, useSwitchOrganization } from '@/features/auth/session';
import { cn, initials } from '@/lib/utils';

/**
 * Lists the signed-in user's organizations. Switching asks the API, which checks the
 * membership and issues a new session for the chosen organization; the UI never decides
 * which organization's data it may see.
 */
export function WorkspaceSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { activeOrganization, organizations } = useActiveSession();
  const switchOrganization = useSwitchOrganization();
  const label = activeOrganization.name;

  return (
    <DropdownMenu>
      <Tooltip content={label} side="right" disabled={!collapsed}>
        <DropdownMenuTrigger
          className={cn(
            'group flex w-full items-center gap-2.5 rounded-md border border-transparent text-left transition-colors',
            'hover:border-border hover:bg-surface-hover data-[state=open]:border-border data-[state=open]:bg-surface-hover',
            collapsed ? 'size-9 justify-center' : 'h-11 px-2',
          )}
          aria-label={`Switch organization. Current: ${label}`}
          aria-busy={switchOrganization.isPending || undefined}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-accent-subtle text-xs font-semibold text-accent-subtle-foreground">
            {switchOrganization.isPending ? <Spinner className="size-3.5" /> : initials(label)}
          </span>
          {!collapsed && (
            <>
              <span className="grid min-w-0 flex-1 leading-tight">
                <span className="truncate text-sm font-medium">{label}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {ROLE_LABELS[activeOrganization.role]}
                </span>
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
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={activeOrganization.id}
          onValueChange={(id) => {
            if (id !== activeOrganization.id) switchOrganization.mutate(id);
          }}
        >
          {organizations.map((organization) => (
            <DropdownMenuRadioItem
              key={organization.id}
              value={organization.id}
              disabled={switchOrganization.isPending}
            >
              <Building2 aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{organization.name}</span>
              <span className="text-xs text-muted-foreground">
                {ROLE_LABELS[organization.role]}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {switchOrganization.isError && (
          <DropdownMenuItem disabled className="h-auto py-2 text-xs text-danger-foreground">
            {describeAuthError(switchOrganization.error)}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
