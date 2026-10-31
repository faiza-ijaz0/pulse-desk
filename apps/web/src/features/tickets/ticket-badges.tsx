import {
  TICKET_STATUS_LABELS,
  type SlaStatus,
  type SlaTargetState,
  type TicketPriority,
  type TicketStatus,
} from '@pulsedesk/shared';
import {
  AlarmClockOff,
  ArrowDown,
  ArrowUp,
  CircleCheck,
  ChevronsUp,
  Hourglass,
  Minus,
  Timer,
  type LucideIcon,
} from 'lucide-react';
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

/** A thin edge color per priority for rows and headers — decorative; the label carries meaning. */
export const PRIORITY_STRIPES: Record<TicketPriority, string> = {
  URGENT: 'bg-danger',
  HIGH: 'bg-coral',
  NORMAL: 'bg-accent/45',
  LOW: 'bg-border-strong',
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

// SLA states come from the API (`ticket.sla`, computed by evaluateSla), never from the
// browser's clock, so every view and the breach sweep agree. Each badge pairs its color
// with text and an icon, and screen readers hear an "SLA" prefix.

type SlaLook = { label: string; tone: BadgeTone; icon: LucideIcon };

const SLA_STATUS: Record<Exclude<SlaStatus, 'none'>, SlaLook> = {
  on_track: { label: 'On track', tone: 'neutral', icon: Timer },
  at_risk: { label: 'At risk', tone: 'warning', icon: Hourglass },
  first_response_breached: { label: 'Reply breached', tone: 'danger', icon: AlarmClockOff },
  resolution_breached: { label: 'Resolution breached', tone: 'danger', icon: AlarmClockOff },
  met: { label: 'SLA met', tone: 'success', icon: CircleCheck },
};

const SLA_TARGET: Record<Exclude<SlaTargetState, 'none'>, SlaLook> = {
  on_track: { label: 'On track', tone: 'neutral', icon: Timer },
  at_risk: { label: 'At risk', tone: 'warning', icon: Hourglass },
  breached: { label: 'Breached', tone: 'danger', icon: AlarmClockOff },
  met: { label: 'Met', tone: 'success', icon: CircleCheck },
};

function SlaLookBadge({ look }: { look: SlaLook }) {
  const Icon = look.icon;
  return (
    <Badge tone={look.tone}>
      <Icon className="size-3" aria-hidden="true" />
      <span className="sr-only">SLA: </span>
      {look.label}
    </Badge>
  );
}

/** The ticket's overall SLA state; renders nothing when no SLA applies. */
export function SlaBadge({ status }: { status: SlaStatus }) {
  if (status === 'none') return null;
  return <SlaLookBadge look={SLA_STATUS[status]} />;
}

/** One target's state (first reply or resolution); nothing when it has no due date. */
export function SlaTargetBadge({ state }: { state: SlaTargetState }) {
  if (state === 'none') return null;
  return <SlaLookBadge look={SLA_TARGET[state]} />;
}
