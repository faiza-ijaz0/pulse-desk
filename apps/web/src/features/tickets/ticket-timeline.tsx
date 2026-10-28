import type { TimelineEvent, TimelineRef } from '@pulsedesk/shared';
import {
  CircleDot,
  Clock,
  MessageSquare,
  Plus,
  Signal,
  Tags,
  UserRound,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { PRIORITY_LABELS, STATUS_LABELS } from './ticket-badges';
import { RelativeTime } from './ticket-parts';

const name = (ref: TimelineRef | null, missing: string) => (ref ? (ref.name ?? missing) : null);
const list = (refs: TimelineRef[], missing: string) =>
  refs.map((ref) => ref.name ?? missing).join(', ');

/** What happened, phrased to follow the actor's name ("Maya Chen assigned the ticket…"). */
function describe(event: TimelineEvent): { text: string; icon: LucideIcon; danger?: boolean } {
  switch (event.type) {
    case 'CREATED':
      return { text: 'Ticket created', icon: Plus };
    case 'STATUS_CHANGED':
      return {
        text: `changed the status from ${STATUS_LABELS[event.data.from]} to ${STATUS_LABELS[event.data.to]}`,
        icon: CircleDot,
      };
    case 'PRIORITY_CHANGED':
      return {
        text: `changed the priority from ${PRIORITY_LABELS[event.data.from]} to ${PRIORITY_LABELS[event.data.to]}`,
        icon: Signal,
      };
    case 'ASSIGNED': {
      const to = name(event.data.to, 'a former member');
      const from = name(event.data.from, 'a former member');
      return {
        text: to
          ? `assigned the ticket to ${to}`
          : `unassigned the ticket from ${from ?? 'nobody'}`,
        icon: UserRound,
      };
    }
    case 'TEAM_CHANGED': {
      const to = name(event.data.to, 'a deleted team');
      return {
        text: to ? `moved the ticket to ${to}` : 'removed the ticket from its team',
        icon: UsersRound,
      };
    }
    case 'TAGS_CHANGED': {
      const parts = [
        event.data.added.length > 0 && `added ${list(event.data.added, 'a deleted tag')}`,
        event.data.removed.length > 0 && `removed ${list(event.data.removed, 'a deleted tag')}`,
      ].filter(Boolean);
      return { text: parts.join(' and ') || 'changed the tags', icon: Tags };
    }
    case 'MESSAGE_ADDED':
      return {
        text: event.data.visibility === 'INTERNAL' ? 'added an internal note' : 'replied',
        icon: MessageSquare,
      };
    case 'SLA_FIRST_RESPONSE_BREACHED':
      return { text: 'First-response target missed', icon: Clock, danger: true };
    case 'SLA_RESOLUTION_BREACHED':
      return { text: 'Resolution target missed', icon: Clock, danger: true };
  }
}

/** Events that read as sentences without an actor ("Ticket created"). */
const STANDALONE = new Set<TimelineEvent['type']>([
  'CREATED',
  'SLA_FIRST_RESPONSE_BREACHED',
  'SLA_RESOLUTION_BREACHED',
]);

/** Who to name before the event text: PulseDesk for system events, never for a deleted user. */
function actorName(event: TimelineEvent): string | null {
  if (STANDALONE.has(event.type)) return null;
  if (event.actorType === 'SYSTEM') return 'PulseDesk';
  return event.actor?.name ?? 'A former member';
}

export function TicketTimeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">No activity recorded yet.</p>;
  }
  return (
    <div className="relative">
      {/* The connecting rail behind the icons. */}
      <span aria-hidden="true" className="absolute top-2 bottom-2 left-3 w-px bg-border" />
      <ol aria-label="Activity" className="relative grid gap-4">
        {events.map((event) => {
          const { text, icon: Icon, danger } = describe(event);
          const actor = actorName(event);
          return (
            <li key={event.id} className="relative flex gap-3">
              <span
                className={cn(
                  'relative flex size-6 shrink-0 items-center justify-center rounded-full border bg-surface',
                  danger
                    ? 'border-danger/30 text-danger-foreground'
                    : 'border-border text-muted-foreground',
                )}
              >
                <Icon className="size-3" aria-hidden="true" />
              </span>
              <div className="min-w-0 pt-0.5 text-sm">
                <p className={cn('leading-snug', danger && 'text-danger-foreground')}>
                  {actor && <span className="font-medium">{actor} </span>}
                  {text}
                </p>
                <RelativeTime iso={event.createdAt} className="text-xs text-muted-foreground" />
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
