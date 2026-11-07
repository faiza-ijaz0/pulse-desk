import { BarChart3, Table2 } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip } from '@/components/ui/tooltip';
import { formatDuration } from '@/features/dashboard/format';
import { cn } from '@/lib/utils';

/* ─── Labels ────────────────────────────────────────────────────────────────── */

const dayFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const dayWithYearFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * "Nov 7" (or "Nov 7, 2026" with `withYear`) for a calendar date (`YYYY-MM-DD`), independent
 * of the viewer's zone.
 */
export function formatDay(date: string, withYear = false): string {
  return (withYear ? dayWithYearFormat : dayFormat).format(new Date(`${date}T00:00:00.000Z`));
}

/** True when the dates don't all fall in one year, so "Nov 7" alone would be ambiguous. */
export function spansYears(from: string, to: string): boolean {
  return from.slice(0, 4) !== to.slice(0, 4);
}

/** "Oct 9 – Nov 7, 2026", or "Nov 8, 2025 – Nov 7, 2026" across a new year. */
export function formatRange(from: string, to: string): string {
  return spansYears(from, to)
    ? `${formatDay(from, true)} – ${formatDay(to, true)}`
    : `${formatDay(from)} – ${formatDay(to, true)}`;
}

/** "Nov 7" for a day, "Nov 1 – Nov 7" for a longer bucket (with years when asked). */
export function formatBucket(bucket: { start: string; end: string }, withYear = false): string {
  return bucket.start === bucket.end
    ? formatDay(bucket.start, withYear)
    : `${formatDay(bucket.start, withYear)} – ${formatDay(bucket.end, withYear)}`;
}

/* ─── Scales ────────────────────────────────────────────────────────────────── */

/** A round axis maximum for counts: 1, 2 or 5 × 10ⁿ steps, four of them. */
function countScale(max: number): { max: number; ticks: number[] } {
  if (max <= 4) return { max: 4, ticks: [0, 1, 2, 3, 4] };
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  return { max: step * 4, ticks: [0, 1, 2, 3, 4].map((i) => i * step) };
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

/** A round axis maximum for durations, in whole seconds, minutes, hours or days. */
function durationScale(max: number): { max: number; ticks: number[] } {
  const unit = max <= MINUTE ? 1 : max <= HOUR ? MINUTE : max <= 2 * DAY ? HOUR : DAY;
  const scaled = countScale(Math.max(max / unit, 1));
  return { max: scaled.max * unit, ticks: scaled.ticks.map((t) => t * unit) };
}

function durationTick(seconds: number): string {
  if (seconds === 0) return '0';
  if (seconds < MINUTE || seconds % MINUTE !== 0) return `${seconds}s`;
  if (seconds < HOUR) return `${seconds / MINUTE}m`;
  if (seconds < DAY || seconds % DAY !== 0) return `${seconds / HOUR}h`;
  return `${seconds / DAY}d`;
}

/* ─── Chart / table toggle ──────────────────────────────────────────────────── */

type View = 'chart' | 'table';

function ViewToggle({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  const options = [
    { value: 'chart', label: 'Chart', icon: BarChart3 },
    { value: 'table', label: 'Table', icon: Table2 },
  ] as const;
  return (
    <div
      role="group"
      aria-label="Display as"
      className="inline-flex shrink-0 rounded-lg border border-border bg-surface-sunken p-0.5"
    >
      {options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={view === value}
          onClick={() => onChange(value)}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            view === value
              ? 'bg-surface text-foreground shadow-xs'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}

/* ─── Column chart ──────────────────────────────────────────────────────────── */

export type ChartSeries = {
  key: string;
  label: string;
  /** Solid swatch (legend, tooltip) and the column fill. */
  swatch: string;
  /** One value per bucket; `null` = no data for that bucket (no column, said so in text). */
  values: (number | null)[];
};

type Bucket = { start: string; end: string };

/**
 * Columns over time on one y-axis. One series needs no legend (the title names it); two get
 * a legend. Every bucket has a tooltip and a spoken label, and the Table view lists every
 * exact value, which is also the keyboard route through the data.
 */
export function ColumnChart({
  title,
  description,
  buckets,
  series,
  kind,
  summary,
  emptyValue = 'No data',
}: {
  title: string;
  description: ReactNode;
  buckets: Bucket[];
  series: ChartSeries[];
  kind: 'count' | 'duration';
  /** Spoken summary of the whole chart (the figure caption). */
  summary: string;
  /** How a `null` value reads in tooltips and the table. */
  emptyValue?: string;
}) {
  const [view, setView] = useState<View>('chart');
  const titleId = useId();
  const peak = Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const scale = kind === 'count' ? countScale(peak) : durationScale(peak);
  const format = (value: number | null) =>
    value === null ? emptyValue : kind === 'count' ? String(value) : formatDuration(value);
  const tick = kind === 'count' ? String : durationTick;
  // Tooltips, spoken labels and the table name the year when the range crosses one.
  const withYear = spansYears(buckets[0]?.start ?? '', buckets.at(-1)?.end ?? '');
  // About eight x-axis labels at most, evenly spaced, always including the first bucket.
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));
  // A label is centred on its column and may be wider than it: skip one too close to the
  // right edge (it would be clipped), and on phones show every other label (about four).
  const lastLabelled = buckets.length - 1 - Math.floor(labelEvery / 2);
  const axisLabel = (index: number) => {
    if (index % labelEvery !== 0 || (index > 0 && index > lastLabelled)) return null;
    return (index / labelEvery) % 2 === 0 ? 'inline-block' : 'hidden sm:inline-block';
  };

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle id={titleId}>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <ViewToggle view={view} onChange={setView} />
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {view === 'table' ? (
          <div className="max-h-80 overflow-y-auto">
            <Table aria-labelledby={titleId}>
              <TableHeader>
                <TableRow>
                  <TableHead>{buckets[0]?.start === buckets[0]?.end ? 'Day' : 'Period'}</TableHead>
                  {series.map((s) => (
                    <TableHead key={s.key} className="text-right">
                      {s.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {buckets.map((bucket, index) => (
                  <TableRow key={bucket.start}>
                    <TableCell className="h-9 whitespace-nowrap">
                      {formatBucket(bucket, withYear)}
                    </TableCell>
                    {series.map((s) => (
                      <TableCell key={s.key} className="h-9 text-right tabular-nums">
                        {format(s.values[index] ?? null)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <figure className="flex flex-1 flex-col" aria-labelledby={titleId}>
            {series.length > 1 && (
              <div
                className="mb-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground"
                aria-hidden="true"
              >
                {series.map((s) => (
                  <span key={s.key} className="inline-flex items-center gap-1.5">
                    <span className={cn('size-2.5 rounded-[3px]', s.swatch)} />
                    {s.label}
                  </span>
                ))}
              </div>
            )}
            <div className="relative flex min-h-48 flex-1 pl-9">
              {/* Hairline gridlines and y-axis ticks (recessive). */}
              <div
                className="pointer-events-none absolute inset-y-0 right-0 left-9"
                aria-hidden="true"
              >
                {scale.ticks.map((value) => (
                  <div
                    key={value}
                    className="absolute inset-x-0 border-t border-border"
                    style={{ bottom: `${(value / scale.max) * 100}%` }}
                  >
                    <span className="absolute -top-2 -left-9 w-7 text-right text-2xs text-subtle-foreground tabular-nums">
                      {tick(value)}
                    </span>
                  </div>
                ))}
              </div>
              <div className="relative flex flex-1 items-end">
                {buckets.map((bucket, index) => {
                  const label = `${formatBucket(bucket, withYear)}: ${series
                    .map((s) => `${s.label} ${format(s.values[index] ?? null)}`)
                    .join(', ')}`;
                  return (
                    <Tooltip
                      key={bucket.start}
                      content={
                        <span className="grid gap-1 py-0.5">
                          <span className="font-semibold">{formatBucket(bucket, withYear)}</span>
                          {series.map((s) => (
                            <span key={s.key} className="flex items-center gap-2 font-normal">
                              <span className={cn('size-2 rounded-[2px]', s.swatch)} />
                              {s.label}
                              <span className="ml-auto pl-3 font-medium tabular-nums">
                                {format(s.values[index] ?? null)}
                              </span>
                            </span>
                          ))}
                        </span>
                      }
                    >
                      <div
                        role="img"
                        aria-label={label}
                        className="group flex h-full min-w-0 flex-1 items-end justify-center gap-px rounded-sm px-px hover:bg-surface-hover/70"
                      >
                        {series.map((s) => {
                          const value = s.values[index] ?? null;
                          return (
                            <div
                              key={s.key}
                              className={cn(
                                'w-full max-w-6 rounded-t-[4px] transition-opacity group-hover:opacity-90',
                                s.swatch,
                              )}
                              style={{
                                height: `${value === null ? 0 : (value / scale.max) * 100}%`,
                              }}
                            />
                          );
                        })}
                      </div>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
            {/* Clipped, so a label at the right edge never widens the page on a phone. */}
            <div
              className="flex overflow-hidden pt-2 pl-9 text-2xs text-muted-foreground"
              aria-hidden="true"
            >
              {buckets.map((bucket, index) => (
                <span key={bucket.start} className="min-w-0 flex-1 overflow-visible text-center">
                  {axisLabel(index) ? (
                    <span className={cn('whitespace-nowrap', axisLabel(index))}>
                      {formatDay(bucket.start)}
                    </span>
                  ) : null}
                </span>
              ))}
            </div>
            <figcaption className="sr-only">
              {summary} Use the Table view for exact values.
            </figcaption>
          </figure>
        )}
      </CardContent>
    </Card>
  );
}
