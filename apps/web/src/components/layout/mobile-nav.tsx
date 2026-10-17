import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { ApiStatus } from './api-status';
import { BrandMark } from './brand';
import { SidebarNav } from './sidebar';
import { WorkspaceSwitcher } from './workspace-switcher';

/**
 * Small-screen navigation: a full-width drawer with large touch targets rather than a
 * shrunken desktop sidebar. Closes on navigation, Escape or overlay tap.
 */
export function MobileNav({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent aria-describedby="mobile-nav-description">
        <div className="flex h-14 items-center gap-2.5 px-5">
          <BrandMark />
          <SheetTitle className="text-[0.9375rem] font-semibold tracking-tight">
            PulseDesk
          </SheetTitle>
        </div>
        <SheetDescription id="mobile-nav-description" className="sr-only">
          Main navigation
        </SheetDescription>
        <div className="px-3 pb-2">
          <WorkspaceSwitcher />
        </div>
        <div className="flex-1 overflow-y-auto [&_a]:h-10">
          <SidebarNav indicatorId="nav-active-mobile" onNavigate={() => onOpenChange(false)} />
        </div>
        <div className="border-t border-border px-3 py-2">
          <ApiStatus />
        </div>
      </SheetContent>
    </Sheet>
  );
}
