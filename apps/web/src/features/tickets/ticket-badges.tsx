import type { TicketPriority, TicketStatus } from '@pulsedesk/shared';
import { ArrowDown, ArrowUp, ChevronsUp, Minus, type LucideIcon } from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// Status and priority always pair color with text (and priority with an icon), so
// meaning never depends on color alone.

const STATUS: Record<TicketStatus, { label: string; tone: BadgeTone }> = {
  OPEN: { label: 'Open', tone: 'accent' },
  PENDING: { label: 'Pending', tone: 'warning' },
  ON_HOLD: { label: 'On hold', tone: 'neutral' },
  SOLVED: { label: 'Solved', tone: 'success' },
  CLOSED: { label: 'Closed', tone: 'neutral' },
};

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  const { label, tone } = STATUS[status];
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}

const PRIORITY: Record<TicketPriority, { label: string; icon: LucideIcon; className: string }> = {
  URGENT: { label: 'Urgent', icon: ChevronsUp, className: 'text-danger-foreground' },
  HIGH: { label: 'High', icon: ArrowUp, className: 'text-warning-foreground' },
  NORMAL: { label: 'Normal', icon: Minus, className: 'text-muted-foreground' },
  LOW: { label: 'Low', icon: ArrowDown, className: 'text-subtle-foreground' },
};

export function TicketPriorityLabel({ priority }: { priority: TicketPriority }) {
  const { label, icon: Icon, className } = PRIORITY[priority];
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-foreground">
      <Icon className={cn('size-3.5', className)} aria-hidden="true" />
      {label}
    </span>
  );
}
