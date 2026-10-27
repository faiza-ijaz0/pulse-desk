import type { TicketAssignee, TicketTag } from '@pulsedesk/shared';
import { UserRoundX } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/misc';
import { formatDateTime, formatRelative } from '@/lib/format-time';
import { cn } from '@/lib/utils';

/** Relative time ("3 hr. ago") with the exact time on hover and in the markup. */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={className}>
      {formatRelative(iso)}
    </time>
  );
}

export function AssigneeLabel({ assignee }: { assignee: TicketAssignee | null }) {
  if (!assignee) {
    return (
      <span className="inline-flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-border-strong">
          <UserRoundX className="size-3" aria-hidden="true" />
        </span>
        Unassigned
      </span>
    );
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-2 text-sm">
      <Avatar name={assignee.name} size="sm" className="ring-0" />
      <span className="truncate">{assignee.name}</span>
    </span>
  );
}

// Tag colors are stored as palette names (e.g. "violet"), mapped here onto theme tokens so
// they follow light and dark mode. Unknown values fall back to neutral.
const TAG_DOT: Partial<Record<string, string>> = {
  violet: 'bg-accent',
  red: 'bg-danger',
  blue: 'bg-info',
  green: 'bg-success',
  amber: 'bg-warning',
};

export function TagBadge({ tag }: { tag: TicketTag }) {
  const dot = (tag.color === null ? undefined : TAG_DOT[tag.color]) ?? 'bg-subtle-foreground';
  return (
    <Badge tone="neutral">
      <span aria-hidden="true" className={cn('size-1.5 rounded-full', dot)} />
      {tag.name}
    </Badge>
  );
}

/** Up to `max` tags, then "+N more". */
export function TagList({ tags, max = 3 }: { tags: TicketTag[]; max?: number }) {
  if (tags.length === 0) return null;
  const hidden = tags.length - max;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {tags.slice(0, max).map((tag) => (
        <TagBadge key={tag.id} tag={tag} />
      ))}
      {hidden > 0 && (
        <span
          className="text-xs text-muted-foreground"
          title={tags
            .slice(max)
            .map((t) => t.name)
            .join(', ')}
        >
          +{hidden} more
        </span>
      )}
    </span>
  );
}
