import { Check, ChevronRight, Circle } from 'lucide-react';
import { DropdownMenu as Menu } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuGroup = Menu.Group;
export const DropdownMenuRadioGroup = Menu.RadioGroup;
export const DropdownMenuSub = Menu.Sub;

const surface =
  'z-50 min-w-48 overflow-hidden rounded-xl border border-border bg-surface-overlay p-1.5 text-foreground shadow-lg data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in';

const item = cn(
  'relative flex h-8 cursor-default items-center gap-2 rounded-lg px-2 text-sm outline-none select-none',
  'data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-hover',
  '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
);

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content sideOffset={sideOffset} className={cn(surface, className)} {...props} />
    </Menu.Portal>
  );
}

export function DropdownMenuItem({
  className,
  destructive,
  ...props
}: ComponentProps<typeof Menu.Item> & { destructive?: boolean }) {
  return (
    <Menu.Item
      className={cn(
        item,
        destructive && 'text-danger-foreground [&_svg]:text-danger-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof Menu.CheckboxItem>) {
  return (
    <Menu.CheckboxItem className={cn(item, 'pr-8', className)} {...props}>
      {children}
      <Menu.ItemIndicator className="absolute right-2 flex items-center">
        <Check aria-hidden="true" />
      </Menu.ItemIndicator>
    </Menu.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof Menu.RadioItem>) {
  return (
    <Menu.RadioItem className={cn(item, 'pr-8', className)} {...props}>
      {children}
      <Menu.ItemIndicator className="absolute right-2.5 flex items-center">
        <Circle className="size-2! fill-current text-accent!" aria-hidden="true" />
      </Menu.ItemIndicator>
    </Menu.RadioItem>
  );
}

export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof Menu.SubTrigger>) {
  return (
    <Menu.SubTrigger
      className={cn(item, 'data-[state=open]:bg-surface-hover', className)}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto" aria-hidden="true" />
    </Menu.SubTrigger>
  );
}

export function DropdownMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof Menu.SubContent>) {
  return (
    <Menu.Portal>
      <Menu.SubContent className={cn(surface, className)} {...props} />
    </Menu.Portal>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Menu.Label>) {
  return (
    <Menu.Label
      className={cn('px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground', className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}

export function DropdownMenuShortcut({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn('ml-auto text-xs tracking-wide text-subtle-foreground', className)}
      {...props}
    />
  );
}
