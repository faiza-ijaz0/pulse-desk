import { TICKET_STATUS_LABELS, type TicketPriority, type TicketStatus } from '@pulsedesk/shared';
import { ArrowDown, ArrowUp, ChevronsUp, Minus, type LucideIcon } from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// Status and priority always pair color with text (and priority with an icon), so
// meaning never depends on color alone.

const STATUS_TONES: Record<TicketStatus, BadgeTone> = {
  OPEN: 'accent',
  PENDING: 'warning',
  ON_HOLD: 'neutral',
  SOLVED: 'success',
  CLOSED: 'neutral',
};

export const STATUS_LABELS = TICKET_STATUS_LABELS;

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return (
    <Badge tone={STATUS_TONES[status]} dot>
      {STATUS_LABELS[status]}
    </Badge>
  );
}

const PRIORITY: Record<TicketPriority, { label: string; icon: LucideIcon; className: string }> = {
  URGENT: { label: 'Urgent', icon: ChevronsUp, className: 'text-danger-foreground' },
  HIGH: { label: 'High', icon: ArrowUp, className: 'text-warning-foreground' },
  NORMAL: { label: 'Normal', icon: Minus, className: 'text-muted-foreground' },
  LOW: { label: 'Low', icon: ArrowDown, className: 'text-subtle-foreground' },
};

// Object.fromEntries widens the keys to string; they come from a Record over every value.
export const PRIORITY_LABELS = Object.fromEntries(
  Object.entries(PRIORITY).map(([priority, { label }]) => [priority, label]),
) as Record<TicketPriority, string>;

export function TicketPriorityLabel({ priority }: { priority: TicketPriority }) {
  const { label, icon: Icon, className } = PRIORITY[priority];
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-foreground">
      <Icon className={cn('size-3.5', className)} aria-hidden="true" />
      {label}
    </span>
  );
}
